import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import sharp from "sharp";
import { createApiServer } from "../src/server.mjs";

test("PostgreSQL mode serves live data and stores member images without GitHub", async () => {
  const revisions = { members: "a".repeat(40), posts: "b".repeat(40), popup: "c".repeat(40), logs: "d".repeat(40) };
  const documents = {
    members: [{ name: "Faerie", photo: "https://example.com/old.webp" }],
    posts: [],
    popup: { enabled: false, title: "", description: "", image: "", facebookUrl: "" },
    logs: [],
  };
  const images = new Map();
  const database = {
    async getFile(kind) { return { data: structuredClone(documents[kind]), sha: revisions[kind] }; },
    async saveFile(kind, data, sha) {
      if (sha !== revisions[kind]) throw Object.assign(new Error("Conflict"), { status: 409 });
      documents[kind] = structuredClone(data);
      revisions[kind] = "e".repeat(40);
      return revisions[kind];
    },
    async saveImage(kind, filename, bytes) { images.set(filename, { kind, body: bytes }); },
    async getImage(filename) { return images.get(filename); },
  };
  const env = { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "test-password", ADMIN_SESSION_SECRET: "test-secret" };
  const server = createApiServer({ database, adminOptions: { env } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = "https://faeriehouse-admin.onrender.com";
  try {
    const initial = await (await fetch(`${base}/api/v1/members`)).json();
    assert.equal(initial.members[0].name, "Faerie");
    assert.equal((await (await fetch(`${base}/api/health`)).json()).storage, "postgres");
    const login = await fetch(`${base}/api/v1/admin/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "test-password" }) });
    assert.equal(login.status, 200);
    assert.equal(documents.logs.length, 1);
    const { token } = await login.json();
    const headers = { Origin: origin, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const saved = await fetch(`${base}/api/v1/admin/members`, { method: "PUT", headers, body: JSON.stringify({ sha: revisions.members, data: [{ name: "New member", photo: "https://example.com/new.webp" }] }) });
    assert.equal(saved.status, 200);
    assert.equal((await (await fetch(`${base}/api/v1/members`)).json()).members[0].name, "New member");
    const imageBase64 = (await sharp({ create: { width: 2, height: 2, channels: 4, background: "#80bd65" } }).png().toBuffer()).toString("base64");
    const upload = await fetch(`${base}/api/v1/admin/member-image`, { method: "POST", headers, body: JSON.stringify({ mimeType: "image/png", imageBase64 }) });
    assert.equal(upload.status, 201);
    const imageUrl = (await upload.json()).image;
    const served = await fetch(imageUrl.replace("https://faerienews-backend.onrender.com", base));
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/webp");
  } finally {
    server.close();
    await once(server, "close");
  }
});

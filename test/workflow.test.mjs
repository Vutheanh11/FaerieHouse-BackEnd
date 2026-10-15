import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import sharp from "sharp";
import { hashAdminPassword } from "../src/admin.mjs";
import { totpCode } from "../src/mfa.mjs";
import { createApiServer } from "../src/server.mjs";

const origin = "https://faeriehouse-admin.onrender.com";
const fixedTime = 1_800_000_000_000;

test("campus-scoped drafts, edits, soft delete, restore, image upload and MFA", async () => {
  const documents = {
    members: [{ name: "HCM Member", title: "Member", group: "Member" }],
    posts: [],
    popup: { enabled: false, title: "", description: "", image: "", facebookUrl: "" },
    logs: [],
  };
  const revisions = Object.fromEntries(Object.keys(documents).map((kind) => [kind, randomBytes(20).toString("hex")]));
  const user = { username: "owner", password_hash: await hashAdminPassword("strong-password-123"), role: "super", session_version: 1, disabled: false, mfa_secret: null };
  const images = new Map();
  const database = {
    async getFile(kind) { return { data: structuredClone(documents[kind]), sha: revisions[kind] }; },
    async saveFile(kind, data, revision) {
      if (revision !== revisions[kind]) throw Object.assign(new Error("Conflict"), { status: 409 });
      documents[kind] = structuredClone(data);
      revisions[kind] = randomBytes(20).toString("hex");
      return revisions[kind];
    },
    async getAdminUser(username) { return username === user.username ? { ...user } : null; },
    async setAdminMfaSecret(username, secret, version) {
      assert.equal(username, user.username);
      assert.equal(version, user.session_version);
      user.mfa_secret = secret;
      user.session_version++;
      return { ...user };
    },
    async saveImage(kind, filename, bytes) { images.set(filename, { kind, body: bytes }); },
    async getImage(filename) { return images.get(filename) ?? null; },
  };
  const server = createApiServer({ database, adminOptions: { env: { ADMIN_SESSION_SECRET: "a-long-test-session-secret" }, now: () => fixedTime } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = (path, method = "GET", token = "", body) => fetch(`${base}/api/v1/admin/${path}`, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const login = await (await admin("login", "POST", "", { username: "owner", password: "strong-password-123" })).json();
    const token = login.token;
    assert.ok(token);

    const basePost = {
      id: "d93fbd10-7a48-467b-8de1-d0401a247550", campus: "quy-nhon", status: "draft",
      date: "15.10", year: "2026", title: "Quy Nhơn đầu tiên", description: "",
      bodyBlocks: [], tag: "NEWS", location: "Quy Nhơn", images: [],
    };
    const created = await admin("posts", "POST", token, { post: basePost });
    assert.equal(created.status, 201);
    assert.equal((await (await fetch(`${base}/api/v1/news?campus=quy-nhon`)).json()).total, 0);
    const published = await admin(`posts/${basePost.id}`, "PATCH", token, { post: { ...basePost, status: "published", bodyBlocks: [{ runs: [{ text: "Faerie Quy Nhơn xin chào" }] }] } });
    assert.equal(published.status, 200);
    assert.equal(documents.posts[0].history.length, 1);
    assert.equal((await (await fetch(`${base}/api/v1/news?campus=quy-nhon`)).json()).total, 1);
    assert.equal((await (await fetch(`${base}/api/v1/news?campus=hcm`)).json()).total, 7);
    assert.equal((await admin(`posts/${basePost.id}`, "DELETE", token)).status, 200);
    assert.equal((await (await fetch(`${base}/api/v1/news?campus=quy-nhon`)).json()).total, 0);
    assert.equal((await admin(`posts/${basePost.id}/restore`, "POST", token)).status, 200);
    assert.equal(documents.posts[0].status, "draft");

    const popupDocument = {
      hcm: documents.popup,
      "quy-nhon": { enabled: true, title: "Quy Nhơn gặp mặt", description: "Hẹn gặp ở Quy Nhơn", image: "", facebookUrl: "" },
    };
    assert.equal((await admin("popup", "PUT", token, { data: popupDocument, sha: revisions.popup })).status, 200);
    assert.equal((await (await fetch(`${base}/api/v1/popup?campus=hcm`)).json()).popup.enabled, false);
    assert.equal((await (await fetch(`${base}/api/v1/popup?campus=quy-nhon`)).json()).popup.title, "Quy Nhơn gặp mặt");

    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#476f51" } }).png().toBuffer();
    const uploaded = await admin("news-image", "POST", token, { mimeType: "image/png", imageBase64: png.toString("base64") });
    assert.equal(uploaded.status, 201);
    const { image } = await uploaded.json();
    assert.match(image, /\/api\/v1\/news-images\/[a-f0-9-]+\.webp$/);
    assert.equal((await fetch(image.replace("https://faerienews-backend.onrender.com", base))).status, 200);

    const setup = await admin("mfa/setup", "POST", token, { password: "strong-password-123" });
    assert.equal(setup.status, 200);
    const { secret, setupToken } = await setup.json();
    const code = totpCode(secret, fixedTime);
    const enabled = await admin("mfa/enable", "POST", token, { setupToken, code });
    assert.equal(enabled.status, 200);
    const mfaToken = (await enabled.json()).token;
    assert.equal((await admin("data", "GET", token)).status, 401);
    assert.equal((await admin("login", "POST", "", { username: "owner", password: "strong-password-123" })).status, 202);
    assert.equal((await admin("login", "POST", "", { username: "owner", password: "strong-password-123", code: "000000" })).status, 401);
    assert.equal((await admin("login", "POST", "", { username: "owner", password: "strong-password-123", code })).status, 200);
    assert.ok(documents.logs.some((entry) => entry.status === "failure"));
    const disabled = await admin("mfa/disable", "POST", mfaToken, { password: "strong-password-123", code });
    assert.equal(disabled.status, 200);
    assert.equal(user.mfa_secret, null);
  } finally {
    server.close();
    await once(server, "close");
  }
});

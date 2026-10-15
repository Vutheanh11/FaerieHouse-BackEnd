import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { hashAdminPassword } from "../src/admin.mjs";
import { createApiServer } from "../src/server.mjs";

test("database admin roles allow publishing but reserve account creation and post deletion for super", async () => {
  const documents = {
    members: [{ name: "Faerie", title: "Member" }],
    posts: [],
    popup: { enabled: false, title: "", description: "", image: "", facebookUrl: "" },
    logs: [],
  };
  const revisions = Object.fromEntries(Object.keys(documents).map((kind) => [kind, "a".repeat(40)]));
  const users = new Map([["1", { username: "1", password_hash: await hashAdminPassword("1"), role: "super", session_version: 1, disabled: false }]]);
  const database = {
    async getFile(kind) { return { data: structuredClone(documents[kind]), sha: revisions[kind] }; },
    async saveFile(kind, data, sha) {
      if (sha !== revisions[kind]) throw Object.assign(new Error("Conflict"), { status: 409 });
      documents[kind] = structuredClone(data);
      revisions[kind] = randomBytes(20).toString("hex");
      return revisions[kind];
    },
    async getAdminUser(username) { return users.get(username) ?? null; },
    async listAdminUsers() { return [...users.values()].map(({ username, role, disabled }) => ({ username, role, disabled })); },
    async createAdminUser(username, passwordHash, createdBy) {
      if (users.has(username)) throw Object.assign(new Error("Duplicate"), { status: 409 });
      const user = { username, password_hash: passwordHash, role: "editor", session_version: 1, disabled: false, created_by: createdBy };
      users.set(username, user);
      return { username, role: user.role, created_by: createdBy };
    },
    async changeAdminPassword(username, passwordHash, version) {
      const user = users.get(username);
      if (user.session_version !== version) throw Object.assign(new Error("Conflict"), { status: 409 });
      user.password_hash = passwordHash;
      user.session_version++;
      return user;
    },
  };
  const server = createApiServer({ database, adminOptions: { env: { ADMIN_SESSION_SECRET: "test-secret", ADMIN_USERNAME: "legacy", ADMIN_PASSWORD: "legacy-password" } } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = "GET", token = "", body) => fetch(`${base}/api/v1/admin/${path}`, {
    method,
    headers: { Origin: "https://faeriehouse-admin.onrender.com", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    assert.equal((await request("login", "POST", "", { username: "legacy", password: "legacy-password" })).status, 401);
    const login = await request("login", "POST", "", { username: "1", password: "1" });
    assert.equal(login.status, 200);
    const superSession = await login.json();
    assert.equal(superSession.role, "super");
    assert.equal((await (await request("data", "GET", superSession.token)).json()).members.data.length, 1);

    const created = await request("users", "POST", superSession.token, { username: "editor", password: "a-strong-password" });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).user.role, "editor");
    const editorLogin = await request("login", "POST", "", { username: "editor", password: "a-strong-password" });
    assert.equal(editorLogin.status, 200);
    const editorSession = await editorLogin.json();
    assert.equal(editorSession.role, "editor");
    assert.equal((await (await request("data", "GET", editorSession.token)).json()).members, null);
    assert.equal((await request("users", "POST", editorSession.token, { username: "bad", password: "a-strong-password" })).status, 403);
    assert.equal((await request("login-logs", "GET", editorSession.token)).status, 403);
    assert.equal((await request("members", "PUT", editorSession.token, { data: [], sha: revisions.members })).status, 403);

    const post = {
      id: "d93fbd10-7a48-467b-8de1-d0401a247550", date: "13.10", year: "2026", title: "Tin Faerie",
      description: "Nội dung thử", bodyBlocks: [{ runs: [{ text: "Nội dung thử" }] }], tag: "NEWS", location: "FPTU", images: [],
    };
    assert.equal((await request("posts", "POST", editorSession.token, { post })).status, 201);
    assert.equal(documents.posts.length, 1);
    assert.equal((await request(`posts/${post.id}`, "DELETE", editorSession.token)).status, 403);
    assert.equal((await request("posts", "PUT", editorSession.token, { data: [], sha: revisions.posts })).status, 403);
    assert.equal((await request("popup", "PUT", editorSession.token, { data: documents.popup, sha: revisions.popup })).status, 200);
    assert.equal((await request(`posts/${post.id}`, "DELETE", superSession.token)).status, 200);
    assert.equal(documents.posts.length, 1);
    assert.equal(documents.posts[0].status, "trash");
    assert.equal((await request(`posts/${post.id}/restore`, "POST", superSession.token)).status, 200);
    assert.equal(documents.posts[0].status, "draft");

    const changed = await request("change-password", "POST", superSession.token, { currentPassword: "1", newPassword: "a-much-stronger-password" });
    assert.equal(changed.status, 200);
    assert.equal((await request("data", "GET", superSession.token)).status, 401);
    assert.equal((await request("login", "POST", "", { username: "1", password: "1" })).status, 401);
  } finally {
    server.close();
    await once(server, "close");
  }
});

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { hashAdminPassword } from "../src/admin.mjs";
import { createApiServer } from "../src/server.mjs";

test("database admin roles allow publishing but reserve account creation and post deletion for super", async () => {
  const documents = {
    members: [{ name: "Faerie HCM", title: "Member" }, { name: "Faerie QN", title: "Member", campus: "quy-nhon" }],
    posts: [{ id: "hcm-post", campus: "hcm", title: "HCM" }],
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
    async listAdminUsers() { return [...users.values()].map(({ username, role, campus, disabled }) => ({ username, role, campus, disabled })); },
    async createAdminUser(username, passwordHash, createdBy, role = "editor", campus = null) {
      if (users.has(username)) throw Object.assign(new Error("Duplicate"), { status: 409 });
      const user = { username, password_hash: passwordHash, role, campus, session_version: 1, disabled: false, created_by: createdBy };
      users.set(username, user);
      return { username, role: user.role, campus, created_by: createdBy, disabled: false };
    },
    async updateAdminUser(username, changes, version) {
      const user = users.get(username);
      if (!user || user.role === "super") throw Object.assign(new Error("Not found"), { status: 404 });
      if (user.session_version !== version) throw Object.assign(new Error("Conflict"), { status: 409 });
      const { passwordHash, ...fields } = changes;
      Object.assign(user, fields, ...(passwordHash ? [{ password_hash: passwordHash }] : []), { session_version: user.session_version + 1 });
      return { username, role: user.role, campus: user.campus, disabled: user.disabled };
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
    assert.equal((await (await request("data", "GET", superSession.token)).json()).members.data.length, 2);

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
    assert.equal(documents.posts.length, 2);
    assert.equal((await request(`posts/${post.id}`, "DELETE", editorSession.token)).status, 403);
    assert.equal((await request("posts", "PUT", editorSession.token, { data: [], sha: revisions.posts })).status, 403);
    assert.equal((await request("popup", "PUT", editorSession.token, { data: documents.popup, sha: revisions.popup })).status, 200);

    assert.equal((await request("users", "GET", superSession.token)).status, 200);
    assert.equal((await request("users", "POST", superSession.token, {
      username: "invalid-qn", password: "a-strong-password", role: "campus_admin",
    })).status, 400);
    const campusAdminCreated = await request("users", "POST", superSession.token, {
      username: "qn-admin", password: "a-strong-password", role: "campus_admin", campus: "quy-nhon",
    });
    assert.equal(campusAdminCreated.status, 201);
    const campusLogin = await request("login", "POST", "", { username: "qn-admin", password: "a-strong-password" });
    assert.equal(campusLogin.status, 200);
    const campusSession = await campusLogin.json();
    assert.equal(campusSession.role, "campus_admin");
    assert.equal(campusSession.campus, "quy-nhon");
    const campusData = await (await request("data", "GET", campusSession.token)).json();
    assert.deepEqual(campusData.members.data.map(({ name }) => name), ["Faerie QN"]);
    assert.deepEqual(campusData.posts.data, []);
    assert.equal(campusData.popup.data.enabled, false);
    assert.equal((await request("login-logs", "GET", campusSession.token)).status, 403);
    assert.equal((await request("users", "GET", campusSession.token)).status, 403);

    const qnMember = { name: "New QN member", title: "Member", campus: "quy-nhon" };
    const savedMembers = await request("members", "PUT", campusSession.token, { data: [qnMember], sha: revisions.members });
    assert.equal(savedMembers.status, 200);
    assert.deepEqual(documents.members, [documents.members[0], qnMember]);
    const qnPopup = { enabled: true, title: "Quy Nhơn", description: "Xin chào", image: "", facebookUrl: "" };
    assert.equal((await request("popup", "PUT", campusSession.token, { data: qnPopup, sha: revisions.popup })).status, 200);
    assert.equal(documents.popup.hcm.enabled, false);
    assert.equal(documents.popup["quy-nhon"].title, "Quy Nhơn");

    const qnPost = {
      id: "e1f2e3d4-5a6b-47c8-9d0e-112233445566", campus: "quy-nhon", status: "draft",
      date: "13.10", year: "2026", title: "Tin Quy Nhơn", description: "Nội dung thử",
      bodyBlocks: [{ runs: [{ text: "Nội dung thử" }] }], tag: "NEWS", location: "FPTU Quy Nhơn", images: [],
    };
    assert.equal((await request("posts", "POST", campusSession.token, { post: { ...qnPost, campus: "hcm" } })).status, 400);
    assert.equal((await request("posts", "POST", campusSession.token, { post: qnPost })).status, 201);
    assert.equal((await request("posts/hcm-post", "DELETE", campusSession.token)).status, 404);
    assert.equal((await request(`posts/${qnPost.id}`, "DELETE", campusSession.token)).status, 200);
    assert.equal((await request(`posts/${qnPost.id}/restore`, "POST", campusSession.token)).status, 200);
    assert.equal(documents.posts.find(({ id }) => id === qnPost.id).status, "draft");

    const updatedAccount = await request("users/qn-admin", "PATCH", superSession.token, { password: "a-new-strong-password", disabled: false });
    assert.equal(updatedAccount.status, 200);
    assert.equal((await request("data", "GET", campusSession.token)).status, 401);
    const updatedLogin = await request("login", "POST", "", { username: "qn-admin", password: "a-new-strong-password" });
    assert.equal(updatedLogin.status, 200);
    const updatedCampusSession = await updatedLogin.json();
    assert.equal((await request("users/qn-admin", "DELETE", superSession.token)).status, 200);
    assert.equal((await request("data", "GET", updatedCampusSession.token)).status, 401);
    assert.equal(users.get("qn-admin").disabled, true);

    assert.equal((await request(`posts/${post.id}`, "DELETE", superSession.token)).status, 200);
    assert.equal(documents.posts.length, 3);
    assert.equal(documents.posts.find(({ id }) => id === post.id).status, "trash");
    assert.equal((await request(`posts/${post.id}/restore`, "POST", superSession.token)).status, 200);
    assert.equal(documents.posts.find(({ id }) => id === post.id).status, "draft");

    const changed = await request("change-password", "POST", superSession.token, { currentPassword: "1", newPassword: "a-much-stronger-password" });
    assert.equal(changed.status, 200);
    assert.equal((await request("data", "GET", superSession.token)).status, 401);
    assert.equal((await request("login", "POST", "", { username: "1", password: "1" })).status, 401);
  } finally {
    server.close();
    await once(server, "close");
  }
});

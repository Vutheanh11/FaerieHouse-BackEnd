import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import sharp from "sharp";
import { createApiServer } from "../src/server.mjs";

const origin = "https://faeriehouse-admin.onrender.com";
const env = { ADMIN_USERNAME: "faerie", ADMIN_PASSWORD: "a-long-test-password", ADMIN_SESSION_SECRET: "test-session-secret-with-adequate-length", GITHUB_TOKEN: "test-github-token" };
const files = new Map([
  ["members.json", { sha: "a".repeat(40), data: [{ name: "A", title: "Member" }] }],
  ["posts.json", { sha: "b".repeat(40), data: [] }],
  ["admin-login-log.json", { sha: "c".repeat(40), data: [] }],
  ["popup.json", { sha: "d".repeat(40), data: { enabled: true, title: "Welcome Day 2", description: "Câu chuyện Faerie", image: "images/events/2026/welcome-day-2/WD2_1.webp", facebookUrl: "" } }],
]);
const uploads = [];
const fetchImpl = async (url, options = {}) => {
  assert.match(options.headers.Authorization, /^Bearer test-github-token$/);
  const name = new URL(url).pathname.split("/").at(-1);
  const file = files.get(name);
  if (!file && options.method === "PUT" && /\/data\/popup-images\/[a-f0-9-]{36}\.(webp|png|jpg)$/.test(new URL(url).pathname)) {
    uploads.push({ name, ...JSON.parse(options.body) });
    return Response.json({ content: { sha: "e".repeat(40) } });
  }
  if (!file) return Response.json({}, { status: 404 });
  if (options.method === "PUT") {
    const input = JSON.parse(options.body);
    if (input.sha !== file.sha) return Response.json({}, { status: 409 });
    file.data = JSON.parse(Buffer.from(input.content, "base64").toString("utf8"));
    file.sha = String.fromCharCode(file.sha.charCodeAt(0) + 1).repeat(40);
    return Response.json({ content: { sha: file.sha } });
  }
  return Response.json({ sha: file.sha, content: Buffer.from(JSON.stringify(file.data)).toString("base64") });
};
const server = createApiServer({ adminOptions: { env, fetchImpl } });
let baseUrl;

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await once(server, "close"); });

function call(path, { method = "GET", token, body, originHeader = origin } = {}) {
  return fetch(`${baseUrl}/api/v1/admin/${path}`, {
    method,
    headers: { Origin: originHeader, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("admin routes require the correct origin and a valid session", async () => {
  assert.equal((await call("data")).status, 401);
  assert.equal((await call("popup-image", { method: "POST", body: {} })).status, 401);
  assert.equal((await call("login-logs")).status, 401);
  assert.equal((await call("login", { method: "POST", body: { username: "faerie", password: "wrong" } })).status, 401);
  assert.equal((await call("login", { method: "POST", body: { username: "faerie", password: env.ADMIN_PASSWORD }, originHeader: "https://evil.example" })).status, 403);
  assert.equal(files.get("admin-login-log.json").data.length, 0);
});

test("login records IP and device, then allows reading and saving data", async () => {
  const login = await call("login", { method: "POST", body: { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD } });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  assert.ok(token);
  const logs = await (await call("login-logs", { token })).json();
  assert.equal(logs.logs.length, 1);
  assert.equal(logs.logs[0].username, "faerie");
  assert.ok(logs.logs[0].ip);
  assert.ok(logs.logs[0].device);
  const data = await (await call("data", { token })).json();
  assert.equal(data.members.data[0].name, "A");
  assert.equal(data.popup.data.title, "Welcome Day 2");
  const update = await call("members", { method: "PUT", token, body: { data: [{ name: "B", title: "Member" }], sha: data.members.sha } });
  assert.equal(update.status, 200);
  assert.equal(files.get("members.json").data[0].name, "B");
  const conflict = await call("members", { method: "PUT", token, body: { data: [], sha: data.members.sha } });
  assert.equal(conflict.status, 409);
  const popup = { enabled: true, title: "Sự kiện mới", description: "Cùng tham gia Faerie.", image: "https://faeriehouse.onrender.com/poster.webp", facebookUrl: "https://www.facebook.com/events/123" };
  const savedPopup = await call("popup", { method: "PUT", token, body: { data: popup, sha: data.popup.sha } });
  assert.equal(savedPopup.status, 200);
  assert.deepEqual(files.get("popup.json").data, popup);
  const unsafePopup = await call("popup", { method: "PUT", token, body: { data: { ...popup, facebookUrl: "javascript:alert(1)" }, sha: files.get("popup.json").sha } });
  assert.equal(unsafePopup.status, 400);

  const invalidImage = await call("popup-image", { method: "POST", token, body: { mimeType: "image/png", imageBase64: Buffer.from("not an image").toString("base64") } });
  assert.equal(invalidImage.status, 400);
  assert.equal(uploads.length, 0);
  const imageBase64 = (await sharp({ create: { width: 2, height: 2, channels: 4, background: "#80bd65" } }).png().toBuffer()).toString("base64");
  const upload = await call("popup-image", { method: "POST", token, body: { mimeType: "image/png", imageBase64 } });
  assert.equal(upload.status, 201);
  assert.match((await upload.json()).image, /^https:\/\/faerienews-backend\.onrender\.com\/api\/v1\/popup-images\/[a-f0-9-]{36}\.webp$/);
  assert.equal(uploads.length, 1);
  assert.equal((await sharp(Buffer.from(uploads[0].content, "base64")).metadata()).format, "webp");
});

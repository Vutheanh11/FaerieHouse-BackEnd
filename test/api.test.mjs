import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { once } from "node:events";
import sharp from "sharp";
import { createApiServer } from "../src/server.mjs";
import { popupConfig } from "../src/data.mjs";

const server = createApiServer();
let baseUrl;

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await once(server, "close");
});

test("health and public API documentation respond", async () => {
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  const root = await fetch(baseUrl);
  assert.equal((await root.json()).version, "v1");
});

test("member and event data match the current 2026 site", async () => {
  const membersResponse = await fetch(`${baseUrl}/api/v1/members?year=2026`);
  const members = await membersResponse.json();
  assert.equal(members.total, 34);
  assert.deepEqual(members.members.slice(0, 4).map(({ title }) => title), [
    "Mentor", "Supporter", "Leader Nhà", "Sub Leader Nhà",
  ]);
  assert.match(members.members[0].photo, /^https:\/\/faeriehouse\.onrender\.com\/images\//);

  const events = await (await fetch(`${baseUrl}/api/v1/events`)).json();
  assert.equal(events.total, 7);
  assert.equal(events.events[0].date, "02.07");
  assert.equal(events.events[6].date, "04.09");
  assert.deepEqual(events.availableYears, ["2026"]);
  assert.equal(events.events[0].title, "Khởi động đội ngũ Faerie");
  assert.equal(events.events[3].title, "Kick Off Faerie 2026");
  const news = await (await fetch(`${baseUrl}/api/v1/news`)).json();
  assert.equal(news.total, 7);
  assert.equal(news.news[0].date, "04.09");
  assert.deepEqual(news.availableYears, ["2026"]);
  assert.equal((await (await fetch(`${baseUrl}/api/v1/news?year=2025`)).json()).total, 0);
  assert.equal((await (await fetch(`${baseUrl}/api/v1/events?year=2025`)).json()).total, 0);
  assert.equal((await fetch(`${baseUrl}/api/v1/news?year=next`)).status, 400);
  const popup = await (await fetch(`${baseUrl}/api/v1/popup`)).json();
  assert.equal(popup.popup.enabled, popupConfig.enabled);
  assert.equal(popup.popup.title, popupConfig.title);
  assert.equal(popup.popup.image, popupConfig.image ? new URL(popupConfig.image, "https://faeriehouse.onrender.com/").href : "");
});

test("new popup images are served from GitHub before Render redeploys", async () => {
  const filename = "11111111-1111-4111-8111-111111111111.webp";
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#8aba64" } }).webp().toBuffer();
  let requested = 0;
  const imageServer = createApiServer({
    imageToken: "test-token",
    imageFetch: async (url, options) => {
      requested++;
      assert.match(url, new RegExp(`/data/popup-images/${filename}\\?ref=main$`));
      assert.equal(options.headers.Authorization, "Bearer test-token");
      assert.equal(options.headers.Accept, "application/vnd.github.raw+json");
      return new Response(bytes, { status: 200 });
    },
  });
  imageServer.listen(0, "127.0.0.1");
  await once(imageServer, "listening");
  try {
    const imageUrl = `http://127.0.0.1:${imageServer.address().port}/api/v1/popup-images/${filename}`;
    const image = await fetch(imageUrl);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/webp");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
    assert.equal(requested, 1);
  } finally {
    imageServer.close();
    await once(imageServer, "close");
  }
});

test("news archive exposes additional years when an admin post is published", async () => {
  const archiveServer = createApiServer({ newsPosts: [{ id: "archive-2025", date: "01.09", year: "2025", title: "Một câu chuyện cũ", description: "Lưu lại hành trình", images: [] }] });
  archiveServer.listen(0, "127.0.0.1");
  await once(archiveServer, "listening");
  try {
    const archiveUrl = `http://127.0.0.1:${archiveServer.address().port}/api/v1/news`;
    const all = await (await fetch(archiveUrl)).json();
    assert.deepEqual(all.availableYears, ["2026", "2025"]);
    assert.equal(all.total, 8);
    const older = await (await fetch(`${archiveUrl}?year=2025`)).json();
    assert.equal(older.total, 1);
    assert.equal(older.news[0].id, "archive-2025");
  } finally {
    archiveServer.close();
    await once(archiveServer, "close");
  }
});

test("CORS allows the frontend and rejects unrelated origins", async () => {
  const allowed = await fetch(`${baseUrl}/api/v1/events`, {
    headers: { Origin: "https://faeriehouse.onrender.com" },
  });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://faeriehouse.onrender.com");
  const admin = await fetch(`${baseUrl}/api/v1/members`, {
    headers: { Origin: "https://faeriehouse-admin.onrender.com" },
  });
  assert.equal(admin.headers.get("access-control-allow-origin"), "https://faeriehouse-admin.onrender.com");
  const denied = await fetch(`${baseUrl}/api/v1/events`, {
    headers: { Origin: "https://unrelated.example" },
  });
  assert.equal(denied.status, 403);
  assert.equal((await fetch(`${baseUrl}/api/v1/members?year=2025`)).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/v1/members`, { method: "POST" })).status, 405);
});

test("Quy Nhơn starts empty and does not receive TP.HCM members, events or popup", async () => {
  const members = await (await fetch(`${baseUrl}/api/v1/members?campus=quy-nhon`)).json();
  const news = await (await fetch(`${baseUrl}/api/v1/news?campus=quy-nhon`)).json();
  const events = await (await fetch(`${baseUrl}/api/v1/events?campus=quy-nhon`)).json();
  const popup = await (await fetch(`${baseUrl}/api/v1/popup?campus=quy-nhon`)).json();
  assert.equal(members.total, 0);
  assert.equal(news.total, 0);
  assert.equal(events.total, 0);
  assert.equal(popup.popup.enabled, false);
  assert.equal((await fetch(`${baseUrl}/api/v1/news?campus=unknown`)).status, 400);
});

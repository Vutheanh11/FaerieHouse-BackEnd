import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { events2026, events2026QuyNhon, members2026, popupConfig, posts } from "./data.mjs";
import { createAdminApi } from "./admin.mjs";
import { createDatabase } from "./database.mjs";

const defaultOrigins = "https://faeriehouse.onrender.com,https://faeriehouse-admin.onrender.com,https://vutheanh11.github.io";
const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS ?? defaultOrigins)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const frontendSiteUrl = new URL(process.env.FRONTEND_SITE_URL ?? "https://faeriehouse.onrender.com/");

function publicAsset(path) {
  return path ? new URL(path, frontendSiteUrl).href : "";
}

const campuses = new Set(["hcm", "quy-nhon"]);
function campusOf(item) { return item?.campus === "quy-nhon" ? "quy-nhon" : "hcm"; }
function popupForCampus(document, campus) {
  if (document && typeof document === "object" && document.hcm) return document[campus] ?? { enabled: false, title: "", description: "", image: "", facebookUrl: "" };
  return campus === "hcm" ? document : { enabled: false, title: "", description: "", image: "", facebookUrl: "" };
}

function sendJson(response, status, body, method = "GET", privateResponse = false) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": !privateResponse && status === 200 ? "public, max-age=60" : "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(method === "HEAD" ? undefined : payload);
}

export function createApiServer({ adminOptions, database, imageFetch = fetch, imageToken = process.env.GITHUB_TOKEN, newsPosts = posts } = {}) {
  const env = adminOptions?.env ?? process.env;
  const store = database ?? (env.DATABASE_URL ? createDatabase(env.DATABASE_URL) : null);
  const handleAdmin = createAdminApi({ ...adminOptions, database: store });
  return createHttpServer(async (request, response) => {
    const origin = request.headers.origin;
    response.setHeader("Vary", "Origin");
    if (origin && !allowedOrigins.has(origin)) {
      sendJson(response, 403, { error: "Origin not allowed" }, request.method);
      return;
    }
    if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    let url;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      sendJson(response, 400, { error: "Invalid URL" }, request.method);
      return;
    }
    const { pathname, searchParams } = url;
    const campus = searchParams.get("campus") ?? "hcm";
    if (pathname.startsWith("/api/v1/") && !campuses.has(campus)) {
      sendJson(response, 400, { error: "Unknown campus" }, request.method);
      return;
    }

    if (pathname.startsWith("/api/v1/admin/")) {
      if (origin !== "https://faeriehouse-admin.onrender.com" && origin !== "http://localhost:8000" && origin !== "http://127.0.0.1:8000") {
        sendJson(response, 403, { error: "Admin origin not allowed" }, request.method, true);
        return;
      }
      await handleAdmin(request, pathname, (status, body) => sendJson(response, status, body, request.method, true));
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD, OPTIONS");
      sendJson(response, 405, { error: "Method not allowed" }, request.method);
      return;
    }

    try {
    if (pathname === "/api/health") {
      sendJson(response, 200, { status: "ok", service: "faerienews-backend", storage: store ? "postgres" : "github", popupImageUpload: "server-processed" }, request.method);
      return;
    }
    if (pathname === "/") {
      sendJson(response, 200, {
        service: "Faerie News API",
        version: "v1",
        endpoints: ["/api/health", "/api/v1/members?year=2026&campus=hcm", "/api/v1/events?year=2026&campus=hcm", "/api/v1/news?year=2026&campus=hcm", "/api/v1/popup?campus=hcm"],
      }, request.method);
      return;
    }
    if (pathname === "/api/v1/members") {
      if (searchParams.has("year") && searchParams.get("year") !== "2026") {
        sendJson(response, 400, { error: "Only year 2026 is available for members" }, request.method);
        return;
      }
      const source = store ? (await store.getFile("members")).data : members2026;
      const members = source.filter((person) => campusOf(person) === campus).map((person) => ({ ...person, campus, cohort: person.cohort || "2026", photo: publicAsset(person.photo) }));
      sendJson(response, 200, { year: 2026, campus, total: members.length, members }, request.method, Boolean(store));
      return;
    }
    if (pathname === "/api/v1/events" || pathname === "/api/v1/news") {
      const selectedYear = searchParams.get("year");
      if (selectedYear !== null && !/^\d{4}$/.test(selectedYear)) {
        sendJson(response, 400, { error: "Year must contain four digits" }, request.method);
        return;
      }
      const currentPosts = store ? (await store.getFile("posts")).data : newsPosts;
      const localEvents = campus === "hcm" ? events2026 : events2026QuyNhon;
      const publicPosts = currentPosts.filter((item) => campusOf(item) === campus && (item.status ?? "published") === "published");
      const allItems = pathname.endsWith("/events") ? localEvents : [...publicPosts, ...localEvents];
      const availableYears = [...new Set(allItems.map((item) => String(item.year)))].sort((first, second) => Number(second) - Number(first));
      const dateValue = (item) => Number(`${item.year}${item.date.slice(3, 5)}${item.date.slice(0, 2)}`);
      const items = allItems
        .filter((item) => selectedYear === null || String(item.year) === selectedYear)
        .sort((first, second) => pathname.endsWith("/events") ? dateValue(first) - dateValue(second) : dateValue(second) - dateValue(first))
        .map((item) => ({ ...item, images: (item.images ?? []).map(publicAsset) }));
      const key = pathname.endsWith("/events") ? "events" : "news";
      sendJson(response, 200, { year: selectedYear ? Number(selectedYear) : null, campus, availableYears, total: items.length, [key]: items }, request.method, Boolean(store && key === "news"));
      return;
    }
    if (pathname === "/api/v1/popup") {
      const document = store ? (await store.getFile("popup")).data : popupConfig;
      const currentPopup = popupForCampus(document, campus);
      sendJson(response, 200, { campus, popup: { ...currentPopup, image: publicAsset(currentPopup.image) } }, request.method, Boolean(store));
      return;
    }
    const storedImage = /^\/api\/v1\/(popup|member|news)-images\/([a-f0-9-]{36})\.(webp|png|jpg)$/.exec(pathname);
    if (storedImage) {
      try {
        const filename = `${storedImage[2]}.${storedImage[3]}`;
        let bytes;
        const saved = store ? await store.getImage(filename) : null;
        if (saved) {
          bytes = saved.body;
        } else if (storedImage[1] === "popup") {
          try {
            bytes = await readFile(new URL(`../data/popup-images/${filename}`, import.meta.url));
          } catch (error) {
          if (error.code !== "ENOENT" || !imageToken) throw error;
          const upstream = await imageFetch(`https://api.github.com/repos/Vutheanh11/FaerieHouse-BackEnd/contents/data/popup-images/${filename}?ref=main`, {
            headers: {
              Accept: "application/vnd.github.raw+json",
              Authorization: `Bearer ${imageToken}`,
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "FaerieNews-Backend",
            },
            cache: "no-store",
          });
          if (!upstream.ok) throw Object.assign(new Error(`GitHub image unavailable (${upstream.status})`), { code: upstream.status === 404 ? "ENOENT" : "UPSTREAM" });
          bytes = Buffer.from(await upstream.arrayBuffer());
          if (!bytes.length || bytes.length > 3_000_000) throw Object.assign(new Error("GitHub image size is invalid"), { code: "UPSTREAM" });
          }
        } else {
          throw Object.assign(new Error("Image not found"), { code: "ENOENT" });
        }
        const mime = { webp: "image/webp", png: "image/png", jpg: "image/jpeg" }[storedImage[3]];
        if (storedImage[3] === "webp" && (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP")) {
          throw Object.assign(new Error("GitHub image format is invalid"), { code: "UPSTREAM" });
        }
        response.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": bytes.length,
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(request.method === "HEAD" ? undefined : bytes);
      } catch (error) {
        if (error.code !== "ENOENT") console.error("Popup image error:", error);
        sendJson(response, error.code === "ENOENT" ? 404 : 502, { error: "Ảnh chưa sẵn sàng. Vui lòng thử lại sau ít giây." }, request.method);
      }
      return;
    }

    sendJson(response, 404, { error: "Not found" }, request.method);
    } catch (error) {
      console.error("Public API error:", error);
      sendJson(response, error.status ?? 503, { error: "Dữ liệu tạm thời không sẵn sàng." }, request.method);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number.parseInt(process.env.PORT ?? "10000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  createApiServer().listen(port, "0.0.0.0", () => {
    process.stdout.write(`Faerie News API listening on port ${port}\n`);
  });
}

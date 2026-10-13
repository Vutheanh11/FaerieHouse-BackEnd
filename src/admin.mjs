import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import sharp from "sharp";

const repository = "Vutheanh11/FaerieHouse-BackEnd";
const files = { members: "data/members.json", posts: "data/posts.json", logs: "data/admin-login-log.json", popup: "data/popup.json" };
const maxBodyBytes = 1_000_000;
const maxUploadBodyBytes = 28_000_000;
const maxSourceImageBytes = 20_000_000;
const maxSavedImageBytes = 3_000_000;
const sessionLifetimeMs = 12 * 60 * 60 * 1000;

function validPopup(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.enabled !== "boolean") return false;
  for (const [field, limit] of [["title", 120], ["description", 1200], ["image", 600], ["facebookUrl", 600]]) {
    if (typeof data[field] !== "string" || data[field].length > limit) return false;
  }
  if (data.enabled && (!data.title.trim() || !data.description.trim())) return false;
  try {
    if (data.image && new URL(data.image, "https://faeriehouse.onrender.com/").protocol !== "https:") return false;
    if (data.facebookUrl) {
      const url = new URL(data.facebookUrl);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || !(host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.com" || host === "fb.me")) return false;
    }
  } catch { return false; }
  return true;
}

function constantTimeEqual(first, second) {
  const left = createHmac("sha256", "faerie-admin-compare").update(first).digest();
  const right = createHmac("sha256", "faerie-admin-compare").update(second).digest();
  return timingSafeEqual(left, right);
}

function clientIp(request) {
  const forwarded = String(request.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return isIP(forwarded) ? forwarded : request.socket.remoteAddress ?? "unknown";
}

function deviceLabel(userAgent = "") {
  const ua = String(userAgent).slice(0, 500);
  const os = /iPhone/i.test(ua) ? "iPhone" : /iPad/i.test(ua) ? "iPad" : /Android/i.test(ua) ? "Android" : /Windows/i.test(ua) ? "Windows" : /Mac OS X|Macintosh/i.test(ua) ? "Mac" : /Linux/i.test(ua) ? "Linux" : "Không xác định";
  const browser = /Edg\//i.test(ua) ? "Edge" : /Firefox\//i.test(ua) ? "Firefox" : /Chrome\//i.test(ua) ? "Chrome" : /Safari\//i.test(ua) ? "Safari" : "Trình duyệt khác";
  return `${os} · ${browser}`;
}

function readBody(request, limit = maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) return reject(Object.assign(new Error("Dữ liệu gửi lên quá lớn."), { status: 413 }));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("JSON không hợp lệ."), { status: 400 })); }
    });
    request.on("error", reject);
  });
}

export function createAdminApi({ env = process.env, fetchImpl = fetch, now = () => Date.now(), database = null } = {}) {
  const attempts = new Map();
  const ready = () => Boolean(env.ADMIN_USERNAME && env.ADMIN_PASSWORD && env.ADMIN_SESSION_SECRET && (database || env.GITHUB_TOKEN));
  const githubHeaders = () => ({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "FaerieHouse-Admin",
  });
  const fileUrl = (kind) => `https://api.github.com/repos/${repository}/contents/${files[kind]}`;

  async function getFile(kind) {
    if (database) return database.getFile(kind);
    const response = await fetchImpl(`${fileUrl(kind)}?ref=main`, { headers: githubHeaders(), cache: "no-store" });
    if (!response.ok) throw Object.assign(new Error(`Không đọc được ${files[kind]} từ GitHub (${response.status}).`), { status: 502 });
    const file = await response.json();
    const data = JSON.parse(Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8"));
    if (kind === "popup" ? !validPopup(data) : !Array.isArray(data)) throw Object.assign(new Error("Dữ liệu repo không hợp lệ."), { status: 502 });
    return { data, sha: file.sha };
  }

  async function saveFile(kind, data, sha, message) {
    if (database) return database.saveFile(kind, data, sha);
    const response = await fetchImpl(fileUrl(kind), {
      method: "PUT",
      headers: { ...githubHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ message, content: Buffer.from(`${JSON.stringify(data, null, 2)}\n`).toString("base64"), sha, branch: "main" }),
    });
    if (response.status === 409) throw Object.assign(new Error("Repo vừa được cập nhật. Hãy tải lại trang rồi thử lại."), { status: 409 });
    if (!response.ok) throw Object.assign(new Error(`GitHub chưa lưu được thay đổi (${response.status}).`), { status: 502 });
    const result = await response.json();
    return result.content.sha;
  }

  async function uploadImage(body, kind) {
    if (!body || typeof body.mimeType !== "string" || typeof body.imageBase64 !== "string") return null;
    if (!["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(body.mimeType) ||
        body.imageBase64.length > Math.ceil(maxSourceImageBytes * 4 / 3) + 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(body.imageBase64)) return null;
    const bytes = Buffer.from(body.imageBase64, "base64");
    if (bytes.length < 32 || bytes.length > maxSourceImageBytes) return null;
    let metadata;
    try { metadata = await sharp(bytes, { limitInputPixels: 25_000_000 }).metadata(); }
    catch { return null; }
    if (!["jpeg", "png", "webp", "heif"].includes(metadata.format) || !metadata.width || !metadata.height ||
        metadata.width * metadata.height > 25_000_000) return null;
    let output;
    for (const quality of [82, 68, 54]) {
      try {
        output = await sharp(bytes, { limitInputPixels: 25_000_000 })
          .rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .webp({ quality }).toBuffer();
      } catch { return null; }
      if (output.length <= maxSavedImageBytes) break;
    }
    if (output.length > maxSavedImageBytes) return null;
    const filename = `${randomUUID()}.webp`;
    if (database) {
      await database.saveImage(kind, filename, output);
      return { image: `https://faerienews-backend.onrender.com/api/v1/${kind}-images/${filename}` };
    }
    if (kind !== "popup") throw Object.assign(new Error("Cần cấu hình database trước khi tải ảnh thành viên."), { status: 503 });
    const path = `data/popup-images/${filename}`;
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/contents/${path}`, {
      method: "PUT",
      headers: { ...githubHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Upload Faerie popup image", content: output.toString("base64"), branch: "main" }),
    });
    if (!response.ok) throw Object.assign(new Error(`GitHub chưa lưu được ảnh (${response.status}).`), { status: 502 });
    return { image: `https://faerienews-backend.onrender.com/api/v1/popup-images/${filename}` };
  }

  function signSession() {
    const payload = Buffer.from(JSON.stringify({ u: env.ADMIN_USERNAME, exp: now() + sessionLifetimeMs, n: randomUUID() })).toString("base64url");
    const signature = createHmac("sha256", env.ADMIN_SESSION_SECRET).update(payload).digest("base64url");
    return { token: `${payload}.${signature}`, expiresAt: now() + sessionLifetimeMs };
  }

  function authenticated(request) {
    const authorization = request.headers.authorization ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization);
    if (!match) return false;
    const signature = createHmac("sha256", env.ADMIN_SESSION_SECRET).update(match[1]).digest("base64url");
    if (!constantTimeEqual(signature, match[2])) return false;
    try {
      const payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
      return payload.u === env.ADMIN_USERNAME && Number.isFinite(payload.exp) && payload.exp > now();
    } catch { return false; }
  }

  async function appendLoginLog(request) {
    const entry = {
      time: new Date(now()).toISOString(),
      username: env.ADMIN_USERNAME,
      ip: clientIp(request),
      device: deviceLabel(request.headers["user-agent"]),
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, sha } = await getFile("logs");
      try {
        await saveFile("logs", [...data, entry].slice(-200), sha, "Record Faerie Admin login");
        return;
      } catch (error) {
        if (error.status !== 409 || attempt === 2) throw error;
      }
    }
  }

  return async function handleAdmin(request, pathname, send) {
    if (!pathname.startsWith("/api/v1/admin/")) return false;
    if (!ready()) {
      send(503, { error: "Admin chưa được cấu hình trên Render." });
      return true;
    }
    try {
      if (pathname === "/api/v1/admin/login" && request.method === "POST") {
        const ip = clientIp(request);
        const record = attempts.get(ip) ?? { count: 0, until: 0 };
        if (record.until > now()) {
          send(429, { error: "Đăng nhập sai quá nhiều lần. Hãy thử lại sau 15 phút." });
          return true;
        }
        const body = await readBody(request);
        if (!body || typeof body.username !== "string" || typeof body.password !== "string" ||
            !constantTimeEqual(body.username, env.ADMIN_USERNAME) || !constantTimeEqual(body.password, env.ADMIN_PASSWORD)) {
          const count = record.until > now() - 15 * 60 * 1000 ? record.count + 1 : 1;
          attempts.set(ip, { count, until: count >= 5 ? now() + 15 * 60 * 1000 : now() });
          send(401, { error: "Username hoặc Password không đúng." });
          return true;
        }
        attempts.delete(ip);
        await appendLoginLog(request);
        send(200, signSession());
        return true;
      }
      if (!authenticated(request)) {
        send(401, { error: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại." });
        return true;
      }
      if (pathname === "/api/v1/admin/popup-image" && request.method === "POST") {
        const image = await uploadImage(await readBody(request, maxUploadBodyBytes), "popup");
        if (!image) {
          send(400, { error: "Không xử lý được ảnh. Chọn ảnh JPG, PNG, WebP hoặc HEIC dưới 20 MB và thử lại." });
          return true;
        }
        send(201, image);
        return true;
      }
      if (pathname === "/api/v1/admin/member-image" && request.method === "POST") {
        const image = await uploadImage(await readBody(request, maxUploadBodyBytes), "member");
        if (!image) {
          send(400, { error: "Không xử lý được ảnh. Chọn ảnh JPG, PNG, WebP hoặc HEIC dưới 20 MB và thử lại." });
          return true;
        }
        send(201, image);
        return true;
      }
      if (pathname === "/api/v1/admin/data" && request.method === "GET") {
        const [members, posts, popup] = await Promise.all([getFile("members"), getFile("posts"), getFile("popup")]);
        send(200, { members, posts, popup, username: env.ADMIN_USERNAME });
        return true;
      }
      if (pathname === "/api/v1/admin/login-logs" && request.method === "GET") {
        const logs = await getFile("logs");
        send(200, { logs: logs.data.toReversed() });
        return true;
      }
      const kind = pathname === "/api/v1/admin/members" ? "members" : pathname === "/api/v1/admin/posts" ? "posts" : pathname === "/api/v1/admin/popup" ? "popup" : null;
      if (kind && request.method === "PUT") {
        const body = await readBody(request);
        const validData = kind === "popup" ? validPopup(body?.data) : Array.isArray(body?.data) && body.data.every((item) => item && typeof item === "object" && !Array.isArray(item));
        if (!body || !validData ||
            typeof body.sha !== "string" || !/^[a-f0-9]{40}$/.test(body.sha)) {
          send(400, { error: "Dữ liệu lưu không hợp lệ." });
          return true;
        }
        const current = await getFile(kind);
        if (current.sha !== body.sha) {
          send(409, { error: "Dữ liệu đã thay đổi. Hãy tải lại trang." });
          return true;
        }
        const sha = await saveFile(kind, body.data, current.sha, kind === "members" ? "Update Faerie members" : kind === "posts" ? "Publish Faerie News" : "Update Faerie event popup");
        send(200, { sha });
        return true;
      }
      send(404, { error: "Not found" });
    } catch (error) {
      send(error.status ?? 500, { error: error.status ? error.message : "Admin tạm thời không sẵn sàng." });
      if (!error.status) console.error("Admin API error:", error);
    }
    return true;
  };
}

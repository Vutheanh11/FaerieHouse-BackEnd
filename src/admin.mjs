import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { promisify } from "node:util";
import sharp from "sharp";
import { newTotpSecret, openTotpSecret, readSetupToken, sealTotpSecret, signSetupToken, verifyTotp } from "./mfa.mjs";

const repository = "Vutheanh11/FaerieHouse-BackEnd";
const files = { members: "data/members.json", posts: "data/posts.json", logs: "data/admin-login-log.json", popup: "data/popup.json" };
const maxBodyBytes = 1_000_000;
const maxUploadBodyBytes = 28_000_000;
const maxSourceImageBytes = 20_000_000;
const maxSavedImageBytes = 3_000_000;
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const deriveKey = promisify(scrypt);

export async function hashAdminPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const key = await deriveKey(password, salt, 64);
  return `scrypt$${salt}$${key.toString("base64url")}`;
}

async function verifyAdminPassword(password, storedHash) {
  const match = /^scrypt\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(storedHash ?? "");
  if (!match) return false;
  const expected = Buffer.from(match[2], "base64url");
  if (expected.length !== 64) return false;
  const actual = await deriveKey(password, match[1], expected.length);
  return timingSafeEqual(actual, expected);
}

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

function validPopupDocument(data) {
  return validPopup(data) || (data && validPopup(data.hcm) && validPopup(data["quy-nhon"]));
}
function postCampus(post) { return post?.campus === "quy-nhon" ? "quy-nhon" : "hcm"; }
function postStatus(post) { return post?.status ?? "published"; }
function postSnapshot(post, username, time) {
  const { history, ...content } = post;
  return { ...content, savedBy: username, savedAt: time };
}

function validPost(post) {
  if (!post || typeof post !== "object" || Array.isArray(post) ||
      (post.campus !== undefined && !["hcm", "quy-nhon"].includes(post.campus)) ||
      !["draft", "published", "trash"].includes(postStatus(post)) ||
      typeof post.id !== "string" || !/^[a-f0-9-]{36}$/.test(post.id) ||
      typeof post.date !== "string" || !/^\d{2}\.\d{2}$/.test(post.date) ||
      typeof post.year !== "string" || !/^\d{4}$/.test(post.year) ||
      typeof post.title !== "string" || !post.title.trim() || post.title.length > 100 ||
      typeof post.description !== "string" || post.description.length > 300 ||
      typeof post.tag !== "string" || post.tag.length > 30 ||
      typeof post.location !== "string" || post.location.length > 100 ||
      !Array.isArray(post.images) || post.images.length > 4 ||
      !post.images.every((image) => typeof image === "string" && image.length <= 600 && /^https:\/\//.test(image)) ||
      !Array.isArray(post.bodyBlocks) || post.bodyBlocks.length > 200 ||
      (postStatus(post) === "published" && !post.bodyBlocks.length)) return false;
  let textLength = 0;
  for (const block of post.bodyBlocks) {
    if (!block || !Array.isArray(block.runs) || block.runs.length > 200) return false;
    for (const run of block.runs) {
      if (typeof run?.text !== "string" || run.text.length > 10_000) return false;
      textLength += run.text.length;
    }
  }
  return (postStatus(post) !== "published" || textLength > 0) && textLength <= 10_000;
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
  const legacyEnabled = () => env.ALLOW_LEGACY_ADMIN === "true";
  const ready = () => Boolean(env.ADMIN_SESSION_SECRET && (database?.getAdminUser || (legacyEnabled() && env.ADMIN_USERNAME && env.ADMIN_PASSWORD)) && (database || env.GITHUB_TOKEN));
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
    if (kind === "popup" ? !validPopupDocument(data) : !Array.isArray(data)) throw Object.assign(new Error("Dữ liệu repo không hợp lệ."), { status: 502 });
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

  function signSession(user) {
    const expiresAt = now() + sessionLifetimeMs;
    const payload = Buffer.from(JSON.stringify({ u: user.username, r: user.role, s: user.source, v: user.sessionVersion ?? 0, exp: expiresAt, n: randomUUID() })).toString("base64url");
    const signature = createHmac("sha256", env.ADMIN_SESSION_SECRET).update(payload).digest("base64url");
    return { token: `${payload}.${signature}`, expiresAt, username: user.username, role: user.role, accountType: user.source };
  }

  async function authenticated(request) {
    const authorization = request.headers.authorization ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization);
    if (!match) return null;
    const signature = createHmac("sha256", env.ADMIN_SESSION_SECRET).update(match[1]).digest("base64url");
    if (!constantTimeEqual(signature, match[2])) return null;
    try {
      const payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
      if (!Number.isFinite(payload.exp) || payload.exp <= now() || typeof payload.u !== "string") return null;
      if (payload.s === "database" && database?.getAdminUser) {
        const user = await database.getAdminUser(payload.u);
        return user && !user.disabled && user.role === payload.r && user.session_version === payload.v
          ? { username: user.username, role: user.role, source: "database", sessionVersion: user.session_version, passwordHash: user.password_hash, mfaSecret: user.mfa_secret }
          : null;
      }
      if (legacyEnabled() && payload.s === "legacy" && payload.u === env.ADMIN_USERNAME && payload.r === "super") {
        return { username: env.ADMIN_USERNAME, role: "super", source: "legacy" };
      }
      return null;
    } catch { return null; }
  }

  async function appendLoginLog(request, username, status = "success") {
    const entry = {
      time: new Date(now()).toISOString(),
      username,
      ip: clientIp(request),
      device: deviceLabel(request.headers["user-agent"]),
      status,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, sha } = await getFile("logs");
      try {
        await saveFile("logs", [...data, entry].slice(-200), sha, "Record Faerie Admin login attempt");
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
        let user = null;
        if (body && typeof body.username === "string" && typeof body.password === "string" && body.password.length <= 200) {
          const stored = database?.getAdminUser ? await database.getAdminUser(body.username) : null;
          if (stored && !stored.disabled && await verifyAdminPassword(body.password, stored.password_hash)) {
            if (stored.role === "super" && stored.mfa_secret && !body.code) {
              send(202, { requiresMfa: true, message: "Nhập mã 6 số từ ứng dụng xác thực." });
              return true;
            }
            if (!stored.mfa_secret || verifyTotp(openTotpSecret(stored.mfa_secret, env.ADMIN_SESSION_SECRET), body.code, now())) {
              user = { username: stored.username, role: stored.role, source: "database", sessionVersion: stored.session_version };
            }
          } else if (!stored && legacyEnabled() && env.ADMIN_USERNAME && env.ADMIN_PASSWORD &&
                     constantTimeEqual(body.username, env.ADMIN_USERNAME) && constantTimeEqual(body.password, env.ADMIN_PASSWORD)) {
            user = { username: env.ADMIN_USERNAME, role: "super", source: "legacy" };
          }
        }
        if (!user) {
          const count = record.until > now() - 15 * 60 * 1000 ? record.count + 1 : 1;
          attempts.set(ip, { count, until: count >= 5 ? now() + 15 * 60 * 1000 : now() });
          try { await appendLoginLog(request, String(body?.username ?? "").slice(0, 40), "failure"); }
          catch (error) { console.error("Login audit error:", error); }
          send(401, { error: "Username hoặc Password không đúng." });
          return true;
        }
        attempts.delete(ip);
        await appendLoginLog(request, user.username);
        send(200, signSession(user));
        return true;
      }
      const user = await authenticated(request);
      if (!user) {
        send(401, { error: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại." });
        return true;
      }
      if (pathname === "/api/v1/admin/change-password" && request.method === "POST") {
        if (user.source !== "database" || !database?.changeAdminPassword) {
          send(403, { error: "Tài khoản Render cũ chỉ đổi mật khẩu trong Render Environment." });
          return true;
        }
        const body = await readBody(request);
        if (typeof body?.currentPassword !== "string" || typeof body?.newPassword !== "string" ||
            body.newPassword.length < 12 || body.newPassword.length > 200) {
          send(400, { error: "Mật khẩu mới cần từ 12 đến 200 ký tự." });
          return true;
        }
        if (!await verifyAdminPassword(body.currentPassword, user.passwordHash)) {
          send(401, { error: "Mật khẩu hiện tại không đúng." });
          return true;
        }
        const updated = await database.changeAdminPassword(user.username, await hashAdminPassword(body.newPassword), user.sessionVersion);
        send(200, signSession({ username: updated.username, role: updated.role, source: "database", sessionVersion: updated.session_version }));
        return true;
      }
      if (pathname === "/api/v1/admin/mfa/setup" && request.method === "POST") {
        if (user.role !== "super" || user.source !== "database" || !database?.setAdminMfaSecret) { send(403, { error: "Chỉ admin lớn trong database được bật xác thực hai bước." }); return true; }
        if (database.isMfaReady && !await database.isMfaReady()) { send(503, { error: "Xác thực hai bước chưa sẵn sàng trên database. Vui lòng liên hệ quản trị viên." }); return true; }
        if (user.mfaSecret) { send(409, { error: "Xác thực hai bước đã được bật." }); return true; }
        const body = await readBody(request);
        if (!await verifyAdminPassword(body?.password ?? "", user.passwordHash)) { send(401, { error: "Mật khẩu hiện tại không đúng." }); return true; }
        const secret = newTotpSecret();
        const setupToken = signSetupToken({ u: user.username, v: user.sessionVersion, secret, exp: now() + 10 * 60_000 }, env.ADMIN_SESSION_SECRET);
        const issuer = encodeURIComponent("Faerie House Admin");
        const label = encodeURIComponent(`Faerie House Admin:${user.username}`);
        send(200, { secret, setupToken, otpAuthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30` });
        return true;
      }
      if (pathname === "/api/v1/admin/mfa/enable" && request.method === "POST") {
        if (user.role !== "super" || user.source !== "database" || !database?.setAdminMfaSecret || user.mfaSecret) { send(403, { error: "Không thể bật xác thực hai bước." }); return true; }
        const body = await readBody(request);
        const setup = readSetupToken(body?.setupToken, env.ADMIN_SESSION_SECRET);
        if (!setup || setup.u !== user.username || setup.v !== user.sessionVersion || setup.exp <= now() || !verifyTotp(setup.secret, body?.code, now())) {
          send(400, { error: "Mã xác thực không đúng hoặc đã hết hạn." }); return true;
        }
        const updated = await database.setAdminMfaSecret(user.username, sealTotpSecret(setup.secret, env.ADMIN_SESSION_SECRET), user.sessionVersion);
        try { await appendLoginLog(request, user.username, "mfa-enabled"); }
        catch (error) { console.error("MFA audit error:", error); }
        send(200, { ...signSession({ username: updated.username, role: updated.role, source: "database", sessionVersion: updated.session_version }), mfaEnabled: true });
        return true;
      }
      if (pathname === "/api/v1/admin/mfa/disable" && request.method === "POST") {
        if (user.role !== "super" || user.source !== "database" || !user.mfaSecret || !database?.setAdminMfaSecret) { send(403, { error: "Xác thực hai bước chưa được bật." }); return true; }
        const body = await readBody(request);
        if (!await verifyAdminPassword(body?.password ?? "", user.passwordHash) || !verifyTotp(openTotpSecret(user.mfaSecret, env.ADMIN_SESSION_SECRET), body?.code, now())) {
          send(401, { error: "Mật khẩu hoặc mã xác thực không đúng." }); return true;
        }
        const updated = await database.setAdminMfaSecret(user.username, null, user.sessionVersion);
        try { await appendLoginLog(request, user.username, "mfa-disabled"); }
        catch (error) { console.error("MFA audit error:", error); }
        send(200, { ...signSession({ username: updated.username, role: updated.role, source: "database", sessionVersion: updated.session_version }), mfaEnabled: false });
        return true;
      }
      if (pathname === "/api/v1/admin/users" && request.method === "GET") {
        if (user.role !== "super") { send(403, { error: "Chỉ admin lớn được xem tài khoản." }); return true; }
        if (!database?.listAdminUsers) { send(503, { error: "Cần kết nối database để quản lý tài khoản." }); return true; }
        send(200, { users: await database.listAdminUsers() });
        return true;
      }
      if (pathname === "/api/v1/admin/users" && request.method === "POST") {
        if (user.role !== "super") { send(403, { error: "Chỉ admin lớn được tạo admin nhỏ." }); return true; }
        if (!database?.createAdminUser) { send(503, { error: "Cần kết nối database để tạo tài khoản." }); return true; }
        const body = await readBody(request);
        const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
        if (!/^[a-z0-9._-]{3,40}$/.test(username) || typeof body?.password !== "string" ||
            body.password.length < 12 || body.password.length > 200) {
          send(400, { error: "Username cần 3–40 ký tự (a-z, 0-9, ._-); mật khẩu cần ít nhất 12 ký tự." });
          return true;
        }
        const created = await database.createAdminUser(username, await hashAdminPassword(body.password), user.username);
        send(201, { user: created });
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
        if (user.role !== "super") { send(403, { error: "Admin nhỏ không được sửa thành viên." }); return true; }
        const image = await uploadImage(await readBody(request, maxUploadBodyBytes), "member");
        if (!image) {
          send(400, { error: "Không xử lý được ảnh. Chọn ảnh JPG, PNG, WebP hoặc HEIC dưới 20 MB và thử lại." });
          return true;
        }
        send(201, image);
        return true;
      }
      if (pathname === "/api/v1/admin/news-image" && request.method === "POST") {
        const image = await uploadImage(await readBody(request, maxUploadBodyBytes), "news");
        if (!image) { send(400, { error: "Không xử lý được ảnh. Chọn JPG, PNG, WebP hoặc HEIC dưới 20 MB." }); return true; }
        send(201, image);
        return true;
      }
      if (pathname === "/api/v1/admin/data" && request.method === "GET") {
        const [members, posts, popup] = await Promise.all([user.role === "super" ? getFile("members") : null, getFile("posts"), getFile("popup")]);
        send(200, { members, posts, popup, username: user.username, role: user.role, accountType: user.source, mfaEnabled: Boolean(user.mfaSecret) });
        return true;
      }
      if (pathname === "/api/v1/admin/login-logs" && request.method === "GET") {
        if (user.role !== "super") { send(403, { error: "Chỉ admin lớn được xem nhật ký." }); return true; }
        const logs = await getFile("logs");
        send(200, { logs: logs.data.toReversed() });
        return true;
      }
      if (pathname === "/api/v1/admin/posts" && request.method === "POST") {
        const body = await readBody(request);
        if (!validPost(body?.post) || postStatus(body.post) === "trash") { send(400, { error: "Bài đăng không hợp lệ." }); return true; }
        const post = { ...body.post, campus: postCampus(body.post), status: postStatus(body.post), history: [], createdBy: user.username, updatedAt: new Date(now()).toISOString() };
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = await getFile("posts");
          if (current.data.some((item) => item.id === post.id)) {
            send(409, { error: "Bài đăng này đã tồn tại." }); return true;
          }
          try {
            const sha = await saveFile("posts", [post, ...current.data], current.sha, "Save Faerie News");
            send(201, { sha, post }); return true;
          } catch (error) { if (error.status !== 409 || attempt === 2) throw error; }
        }
      }
      const postToDelete = /^\/api\/v1\/admin\/posts\/([a-zA-Z0-9_-]{1,120})$/.exec(pathname);
      if (postToDelete && request.method === "PATCH") {
        const body = await readBody(request);
        if (!validPost(body?.post) || body.post.id !== postToDelete[1] || postStatus(body.post) === "trash") {
          send(400, { error: "Bài đăng không hợp lệ." }); return true;
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = await getFile("posts");
          const index = current.data.findIndex((item) => item.id === postToDelete[1]);
          if (index < 0 || postStatus(current.data[index]) === "trash") { send(404, { error: "Không tìm thấy bài cần sửa." }); return true; }
          const previous = current.data[index];
          const history = [...(previous.history ?? []), postSnapshot(previous, user.username, new Date(now()).toISOString())].slice(-20);
          const post = { ...body.post, campus: postCampus(body.post), status: postStatus(body.post), createdBy: previous.createdBy, history, updatedAt: new Date(now()).toISOString() };
          try {
            const sha = await saveFile("posts", current.data.with(index, post), current.sha, "Edit Faerie News");
            send(200, { sha, post }); return true;
          } catch (error) { if (error.status !== 409 || attempt === 2) throw error; }
        }
      }
      const restorePost = /^\/api\/v1\/admin\/posts\/([a-zA-Z0-9_-]{1,120})\/restore$/.exec(pathname);
      if (restorePost && request.method === "POST") {
        if (user.role !== "super") { send(403, { error: "Chỉ admin lớn được khôi phục bài." }); return true; }
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = await getFile("posts");
          const index = current.data.findIndex((item) => item.id === restorePost[1] && postStatus(item) === "trash");
          if (index < 0) { send(404, { error: "Không tìm thấy bài trong thùng rác." }); return true; }
          const post = { ...current.data[index], status: "draft", updatedAt: new Date(now()).toISOString() };
          try {
            const sha = await saveFile("posts", current.data.with(index, post), current.sha, "Restore Faerie News draft");
            send(200, { sha, post }); return true;
          } catch (error) { if (error.status !== 409 || attempt === 2) throw error; }
        }
      }
      if (postToDelete && request.method === "DELETE") {
        if (user.role !== "super") { send(403, { error: "Chỉ admin lớn được xóa bài đăng." }); return true; }
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = await getFile("posts");
          const index = current.data.findIndex((post) => post.id === postToDelete[1] && postStatus(post) !== "trash");
          if (index < 0) { send(404, { error: "Không tìm thấy bài đăng trong database." }); return true; }
          const post = { ...current.data[index], status: "trash", updatedAt: new Date(now()).toISOString() };
          try {
            const sha = await saveFile("posts", current.data.with(index, post), current.sha, "Move Faerie News post to trash");
            send(200, { sha, post }); return true;
          } catch (error) { if (error.status !== 409 || attempt === 2) throw error; }
        }
      }
      const kind = pathname === "/api/v1/admin/members" ? "members" : pathname === "/api/v1/admin/posts" ? "posts" : pathname === "/api/v1/admin/popup" ? "popup" : null;
      if (kind && request.method === "PUT") {
        if (user.role !== "super" && kind !== "popup") { send(403, { error: "Admin nhỏ chỉ được đăng bài và chỉnh popup sự kiện." }); return true; }
        const body = await readBody(request);
        const validData = kind === "popup" ? validPopupDocument(body?.data) : Array.isArray(body?.data) && body.data.every((item) => item && typeof item === "object" && !Array.isArray(item));
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

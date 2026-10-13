import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const root = fileURLToPath(new URL("../", import.meta.url));
const frontendPublic = resolve(root, "../FaerieHouse/public");
const backendData = resolve(root, "data");
const baseUrl = "https://faerienews-backend.onrender.com";
assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");

function imageName(bytes) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}.webp`;
}

const source = Object.fromEntries(await Promise.all(
  ["members", "posts", "popup", "logs"].map(async (kind) => {
    const filename = kind === "logs" ? "admin-login-log" : kind;
    return [kind, JSON.parse(await readFile(resolve(backendData, `${filename}.json`), "utf8"))];
  }),
));
assert.ok(Array.isArray(source.members) && Array.isArray(source.posts) && Array.isArray(source.logs));
assert.equal(typeof source.popup, "object");

const images = new Map();
for (const member of source.members) {
  if (!/^images\/members\/2026\/cards\/[a-zA-Z0-9_-]+\.webp$/.test(member.photo)) continue;
  const file = resolve(frontendPublic, member.photo);
  assert.ok(file.startsWith(`${frontendPublic}${sep}`), "Invalid member photo path");
  const bytes = await readFile(file);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF", `Invalid WebP: ${member.photo}`);
  const filename = imageName(bytes);
  images.set(filename, { kind: "member", bytes });
  member.photo = `${baseUrl}/api/v1/member-images/${filename}`;
}
for (const filename of await readdir(resolve(backendData, "popup-images"))) {
  if (!/^[a-f0-9-]{36}\.webp$/.test(filename)) continue;
  images.set(filename, { kind: "popup", bytes: await readFile(resolve(backendData, "popup-images", filename)) });
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const existing = await client.query("SELECT (SELECT count(*) FROM faerie_documents)::int AS documents, (SELECT count(*) FROM faerie_images)::int AS images");
  assert.equal(existing.rows[0].documents, 0, "Database already contains documents; migration stopped to protect data");
  assert.equal(existing.rows[0].images, 0, "Database already contains images; migration stopped to protect data");
  for (const [filename, image] of images) {
    await client.query("INSERT INTO faerie_images (filename, kind, mime_type, body) VALUES ($1, $2, 'image/webp', $3)", [filename, image.kind, image.bytes]);
  }
  for (const [kind, data] of Object.entries(source)) {
    await client.query("INSERT INTO faerie_documents (kind, data, revision) VALUES ($1, $2::jsonb, $3)", [kind, JSON.stringify(data), randomBytes(20).toString("hex")]);
  }
  await client.query("COMMIT");
  process.stdout.write(`Migrated ${source.members.length} members, ${source.posts.length} posts, ${source.logs.length} login logs, ${images.size} images.\n`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}

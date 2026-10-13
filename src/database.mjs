import { randomBytes } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const kinds = new Set(["members", "posts", "popup", "logs"]);
const imageKinds = new Set(["member", "popup"]);

export function createDatabase(connectionString) {
  const pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });

  return {
    async getAdminUser(username) {
      const result = await pool.query(
        "SELECT username, password_hash, role, session_version, disabled FROM faerie_admin_users WHERE username = $1",
        [username],
      );
      return result.rows[0] ?? null;
    },
    async listAdminUsers() {
      const result = await pool.query(
        "SELECT username, role, created_by, created_at, disabled FROM faerie_admin_users ORDER BY created_at, username",
      );
      return result.rows;
    },
    async createAdminUser(username, passwordHash, createdBy) {
      try {
        const result = await pool.query(
          "INSERT INTO faerie_admin_users (username, password_hash, role, created_by) VALUES ($1, $2, 'editor', $3) RETURNING username, role, created_by, created_at, disabled",
          [username, passwordHash, createdBy],
        );
        return result.rows[0];
      } catch (error) {
        if (error.code === "23505") throw Object.assign(new Error("Username này đã được sử dụng."), { status: 409 });
        throw error;
      }
    },
    async changeAdminPassword(username, passwordHash, sessionVersion) {
      const result = await pool.query(
        "UPDATE faerie_admin_users SET password_hash = $1, session_version = session_version + 1, updated_at = now() WHERE username = $2 AND session_version = $3 AND disabled = false RETURNING username, role, session_version",
        [passwordHash, username, sessionVersion],
      );
      if (!result.rowCount) throw Object.assign(new Error("Tài khoản vừa thay đổi. Hãy đăng nhập lại."), { status: 409 });
      return result.rows[0];
    },
    async getFile(kind) {
      if (!kinds.has(kind)) throw new Error("Unknown data kind");
      const result = await pool.query("SELECT data, revision FROM faerie_documents WHERE kind = $1", [kind]);
      if (!result.rowCount) throw Object.assign(new Error(`Database has no ${kind} data`), { status: 503 });
      return { data: result.rows[0].data, sha: result.rows[0].revision };
    },
    async saveFile(kind, data, sha) {
      if (!kinds.has(kind)) throw new Error("Unknown data kind");
      const revision = randomBytes(20).toString("hex");
      const result = await pool.query(
        "UPDATE faerie_documents SET data = $1::jsonb, revision = $2, updated_at = now() WHERE kind = $3 AND revision = $4 RETURNING revision",
        [JSON.stringify(data), revision, kind, sha],
      );
      if (!result.rowCount) throw Object.assign(new Error("Dữ liệu đã thay đổi. Hãy tải lại trang."), { status: 409 });
      return revision;
    },
    async saveImage(kind, filename, bytes) {
      if (!imageKinds.has(kind) || !/^[a-f0-9-]{36}\.webp$/.test(filename)) throw new Error("Invalid image");
      await pool.query(
        "INSERT INTO faerie_images (filename, kind, mime_type, body) VALUES ($1, $2, 'image/webp', $3)",
        [filename, kind, bytes],
      );
    },
    async getImage(filename) {
      if (!/^[a-f0-9-]{36}\.webp$/.test(filename)) return null;
      const result = await pool.query("SELECT body, mime_type FROM faerie_images WHERE filename = $1", [filename]);
      return result.rows[0] ?? null;
    },
    async check() {
      const result = await pool.query("SELECT count(*)::int AS count FROM faerie_documents");
      return result.rows[0].count;
    },
    close() { return pool.end(); },
  };
}

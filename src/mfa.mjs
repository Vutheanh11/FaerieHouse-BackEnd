import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newTotpSecret() {
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { result += alphabet[(value >>> (bits -= 5)) & 31]; }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}

function decodeBase32(value) {
  let bits = 0;
  let buffer = 0;
  const bytes = [];
  for (const char of value.replace(/=+$/, "").toUpperCase()) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("Invalid TOTP secret");
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) { bytes.push((buffer >>> (bits -= 8)) & 255); }
  }
  return Buffer.from(bytes);
}

export function totpCode(secret, time = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secret, code, time = Date.now()) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((window) => timingSafeEqual(Buffer.from(totpCode(secret, time + window * 30_000)), Buffer.from(code)));
}

function encryptionKey(sessionSecret) {
  return createHash("sha256").update(`faerie-admin-mfa:${sessionSecret}`).digest();
}

export function sealTotpSecret(secret, sessionSecret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(sessionSecret), iv);
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

export function openTotpSecret(sealed, sessionSecret) {
  const [version, iv, tag, body] = String(sealed).split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Invalid MFA data");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(sessionSecret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return decipher.update(Buffer.from(body, "base64url"), undefined, "utf8") + decipher.final("utf8");
}

export function signSetupToken(payload, sessionSecret) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

export function readSetupToken(token, sessionSecret) {
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(token));
  if (!match) return null;
  const signature = createHmac("sha256", sessionSecret).update(match[1]).digest("base64url");
  if (signature.length !== match[2].length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(match[2]))) return null;
  try { return JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")); }
  catch { return null; }
}

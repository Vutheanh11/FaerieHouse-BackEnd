import assert from "node:assert/strict";
import { test } from "node:test";
import { openTotpSecret, readSetupToken, sealTotpSecret, signSetupToken, totpCode, verifyTotp } from "../src/mfa.mjs";

test("TOTP matches the RFC 6238 SHA1 vector at 59 seconds", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totpCode(secret, 59_000), "287082");
  assert.equal(verifyTotp(secret, "287082", 59_000), true);
  assert.equal(verifyTotp(secret, "000000", 59_000), false);
});

test("MFA seeds are sealed and setup tokens reject tampering", () => {
  const sealed = sealTotpSecret("MYSECRET", "server-secret");
  assert.equal(openTotpSecret(sealed, "server-secret"), "MYSECRET");
  assert.throws(() => openTotpSecret(sealed, "other-secret"));
  const token = signSetupToken({ u: "admin", exp: 123 }, "server-secret");
  assert.deepEqual(readSetupToken(token, "server-secret"), { u: "admin", exp: 123 });
  assert.equal(readSetupToken(`${token}bad`, "server-secret"), null);
});

import crypto from "node:crypto";

/**
 * Password hashing with scrypt (RFC 7914), from Node's built-in crypto.
 *
 * Chosen over argon2/bcrypt deliberately: no native compilation, so the server
 * installs and runs on any host without a build toolchain. scrypt is memory-hard
 * and the parameters below meet current guidance.
 *
 * Stored format:  scrypt$N$r$p$<saltB64>$<hashB64>
 */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024, keylen: 32 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password.normalize("NFKC"), salt, SCRYPT.keylen, SCRYPT);
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = crypto.scryptSync(
      password.normalize("NFKC"),
      salt,
      expected.length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem },
    );
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Opaque, high-entropy token. Returned to the client; only its hash is stored. */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Fast hash for lookup keys (refresh tokens, invite codes) — not for passwords. */
export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("base64url");
}

/**
 * Constant-time string comparison. Length is not hidden (it cannot be, for
 * variable-length input) but the contents are, so a caller cannot learn a secret
 * one character at a time. Used for the setup token.
 */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  if (x.length !== y.length) {
    // Still burn a comparison so the timing does not depend on length alone.
    crypto.timingSafeEqual(x, x);
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

/** Human-friendly invite code, e.g. "K4M2-9XQP-7RTB". Avoids look-alike glyphs. */
export function makeInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  const group = () =>
    Array.from(crypto.randomBytes(4))
      .map((b) => alphabet[b % alphabet.length])
      .join("");
  return `${group()}-${group()}-${group()}`;
}

/** Password strength gate. Returns null if acceptable, else a reason string. */
export function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 10) return "must be at least 10 characters";
  if (pw.length > 200) return "must be at most 200 characters";
  if (!/[a-z]/.test(pw) && !/[؀-ۿ]/.test(pw))
    return "must contain a lowercase letter or an Arabic letter";
  if (!/[0-9]/.test(pw)) return "must contain a digit";
  return null;
}

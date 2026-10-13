import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { findUserById, audit } from "./db.js";

/** Thrown by route handlers to produce a clean JSON error. */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const badRequest = (m, c = "bad_request") => new HttpError(400, c, m);
export const unauthorized = (m = "Sign in required", c = "unauthorized") => new HttpError(401, c, m);
export const forbidden = (m = "Not allowed", c = "forbidden") => new HttpError(403, c, m);
export const notFound = (m = "Not found", c = "not_found") => new HttpError(404, c, m);
export const conflict = (m, c = "conflict") => new HttpError(409, c, m);

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, hid: user.household_id, role: user.role, typ: "access" },
    config.jwtSecret,
    { expiresIn: config.accessTokenTtl, issuer: "family-groceries" },
  );
}
export { signAccessToken };

/**
 * Verifies the bearer access token and attaches req.user / req.householdId.
 *
 * The household id is taken from the signed token only — never from the request
 * body, query or path. A client cannot ask for another household's data.
 */
export function requireAuth(req, _res, next) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return next(unauthorized());
  }
  let claims;
  try {
    claims = jwt.verify(token, config.jwtSecret, { issuer: "family-groceries" });
  } catch (e) {
    const expired = e?.name === "TokenExpiredError";
    return next(unauthorized(expired ? "Session expired" : "Invalid session", expired ? "token_expired" : "token_invalid"));
  }
  if (claims.typ !== "access") return next(unauthorized("Invalid session", "token_invalid"));

  const user = findUserById(claims.sub);
  if (!user) return next(unauthorized("Account no longer exists", "token_invalid"));
  if (user.disabled_at) return next(forbidden("Account disabled", "account_disabled"));
  // A role change or household move must not be honoured by an old token.
  if (user.household_id !== claims.hid || user.role !== claims.role) {
    return next(unauthorized("Session no longer valid", "token_stale"));
  }

  req.user = user;
  req.householdId = user.household_id;
  next();
}

/** Route guard for admin-only operations. */
export function requireAdmin(req, _res, next) {
  if (req.user?.role !== "admin") {
    audit(req.householdId, req.user?.id, "authz.denied", `route=${req.path}`, req.ip);
    return next(forbidden("Admin only", "admin_required"));
  }
  next();
}

/** Wraps an async handler so rejections reach the error middleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

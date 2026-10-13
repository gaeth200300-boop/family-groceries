import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "../config.js";
import {
  hashPassword, verifyPassword, randomToken, passwordProblem, sha256, makeInviteCode, safeEqual,
} from "../crypto.js";
import {
  createHousehold, findUserByEmail, findUserById, getDb, newId, now, audit,
  findRedeemableInvite, redeemInvite, createInvite, listInvites, revokeInvite,
  storeRefreshToken, consumeRefreshToken, rotateRefreshToken, revokeRefreshToken,
  revokeAllForUser,
} from "../db.js";
import {
  requireAuth, requireAdmin, wrap, signAccessToken,
  badRequest, unauthorized, forbidden, conflict,
} from "../auth.js";

export const authRouter = express.Router();

/* Tight throttle on credential endpoints, keyed by IP. */
const credentialLimiter = rateLimit({
  windowMs: config.authRateLimit.windowMs,
  max: config.authRateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_attempts", message: "Too many attempts. Try again later." },
});

const REFRESH_COOKIE = "fg_refresh";

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax",
    path: "/api/auth",
    maxAge: config.refreshTokenTtlDays * 864e5,
  };
}

// clearCookie must not carry maxAge (Express deprecates it and expires anyway).
function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax",
    path: "/api/auth",
  });
}

function issueSession(res, user, req) {
  const accessToken = signAccessToken(user);
  const refresh = randomToken(48);
  storeRefreshToken({
    householdId: user.household_id,
    userId: user.id,
    token: refresh,
    userAgent: req.get("user-agent"),
    ttlDays: config.refreshTokenTtlDays,
  });
  res.cookie(REFRESH_COOKIE, refresh, refreshCookieOptions());
  return { accessToken, refreshToken: refresh };
}

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  householdId: u.household_id,
});

/* ------------------------------------------------------------------ signup */

/**
 * POST /api/auth/register
 * Invite-only by default: a valid invite code is required to create an account.
 * The FIRST account bootstraps a household (env REQUIRE_INVITE=false only).
 */
const registerSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(80),
  password: z.string().min(1).max(200),
  inviteCode: z.string().max(64).optional(),
  setupToken: z.string().max(200).optional(),
  householdName: z.string().min(1).max(80).optional(),
});

authRouter.post(
  "/register",
  credentialLimiter,
  wrap(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const emailLower = body.email.trim().toLowerCase();
    const pwProblem = passwordProblem(body.password);
    if (pwProblem) throw badRequest(`Password ${pwProblem}`, "weak_password");

    // First-run bootstrap: no users exist anywhere yet.
    const { count } = getDb().prepare(`SELECT COUNT(*) AS count FROM users`).get();
    if (count === 0) {
      // The first (and only unredeemed) account must present the setup token.
      // This keeps REQUIRE_INVITE permanently on, so there is no window in
      // which a stranger who finds the URL first would become the owner.
      if (config.setupToken) {
        if (!safeEqual(body.setupToken || "", config.setupToken)) {
          audit(null, null, "auth.bootstrap.denied", emailLower, req.ip);
          throw forbidden(
            "This server has not been claimed yet. A setup token is required.",
            "setup_token_required",
          );
        }
      } else if (config.requireInvite) {
        throw forbidden(
          "This server requires an invite code. Ask the household admin for one.",
          "invite_required",
        );
      } else {
        console.warn(
          "[SECURITY] No SETUP_TOKEN configured and REQUIRE_INVITE=false: " +
            "anyone who reaches /api/auth/register first will become the household owner.",
        );
      }
      const { householdId, userId } = createHousehold({
        name: body.householdName || "عائلتي",
        adminEmail: body.email.trim(),
        adminName: body.name.trim(),
        passwordHash: hashPassword(body.password),
        inviteCodeHash: null,
      });
      const user = findUserById(userId);
      audit(householdId, userId, "auth.register.bootstrap", emailLower, req.ip);
      const session = issueSession(res, user, req);
      return res.status(201).json({ user: publicUser(user), ...session });
    }

    // Every account after the first requires a valid invite. Unreachable while a
    // setup token is configured, because the branch above always returns.
    if (!body.inviteCode) {
      throw forbidden("An invite code is required to join", "invite_required");
    }
    const found = findRedeemableInvite(body.inviteCode.trim().toUpperCase(), emailLower);
    if (!found.ok) {
      const messages = {
        invalid: "That invite code is not valid",
        revoked: "That invite code was revoked",
        used: "That invite code has already been used",
        expired: "That invite code has expired",
        email_mismatch: "That invite code was issued to a different email address",
      };
      throw forbidden(messages[found.reason], `invite_${found.reason}`);
    }

    const d = getDb();
    const inv = found.invite;

    // Checked only now, once a valid invite is in hand. Doing it earlier would
    // let a stranger enumerate which addresses belong to the household by
    // comparing 409 "email taken" against 403 "invite required".
    if (findUserByEmail(emailLower)) {
      throw conflict("That email is already registered", "email_taken");
    }

    const userId = newId("u");
    const ts = now();
    d.prepare(
      `INSERT INTO users (id, household_id, email, email_lower, name, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, inv.household_id, body.email.trim(), emailLower, body.name.trim(),
      hashPassword(body.password), inv.role, ts);
    redeemInvite(inv.id, userId);
    audit(inv.household_id, userId, "auth.register.invited", `invite=${inv.id}`, req.ip);

    const user = findUserById(userId);
    const session = issueSession(res, user, req);
    res.status(201).json({ user: publicUser(user), ...session });
  }),
);

/* ----------------------------------------------------------------- signin */

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

authRouter.post(
  "/login",
  credentialLimiter,
  wrap(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const user = findUserByEmail(body.email.trim().toLowerCase());

    // Always run a hash comparison so response time does not reveal whether the
    // account exists.
    const stored = user?.password_hash ?? hashPassword("placeholder-not-a-real-password");
    const ok = verifyPassword(body.password, stored);

    if (!user || !ok) {
      audit(user?.household_id ?? null, user?.id ?? null, "auth.login.failed", body.email, req.ip);
      throw unauthorized("Email or password is incorrect", "bad_credentials");
    }
    if (user.disabled_at) {
      audit(user.household_id, user.id, "auth.login.disabled", "", req.ip);
      throw forbidden("This account has been disabled", "account_disabled");
    }

    getDb().prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(now(), user.id);
    audit(user.household_id, user.id, "auth.login.ok", "", req.ip);
    const session = issueSession(res, user, req);
    res.json({ user: publicUser(user), ...session });
  }),
);

/* ---------------------------------------------------------------- refresh */

authRouter.post(
  "/refresh",
  wrap(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;
    if (!token) throw unauthorized("No session", "no_refresh");

    const found = consumeRefreshToken(token);
    if (!found.ok) {
      clearRefreshCookie(res);
      throw unauthorized("Session expired, sign in again", "refresh_" + found.reason);
    }
    const user = findUserById(found.row.user_id);
    if (!user || user.disabled_at) {
      clearRefreshCookie(res);
      throw unauthorized("Session no longer valid", "refresh_invalid");
    }

    // Rotate: the presented token is single-use.
    const fresh = randomToken(48);
    rotateRefreshToken({
      oldId: found.row.id,
      newToken: fresh,
      householdId: user.household_id,
      userId: user.id,
      userAgent: req.get("user-agent"),
      ttlDays: config.refreshTokenTtlDays,
    });
    res.cookie(REFRESH_COOKIE, fresh, refreshCookieOptions());
    res.json({ user: publicUser(user), accessToken: signAccessToken(user), refreshToken: fresh });
  }),
);

/* ----------------------------------------------------------------- logout */

authRouter.post(
  "/logout",
  wrap(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) {
      const found = consumeRefreshToken(token);
      if (found.ok) revokeRefreshToken(found.row.id);
    }
    clearRefreshCookie(res);
    res.json({ ok: true });
  }),
);

/* --------------------------------------------------------------------- me */

authRouter.get(
  "/me",
  requireAuth,
  wrap(async (req, res) => {
    const household = getDb().prepare(`SELECT id, name, created_at FROM households WHERE id = ?`).get(req.householdId);
    res.json({ user: publicUser(req.user), household });
  }),
);

/* --------------------------------------------- change password (self-serve) */

const changePwSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

authRouter.post(
  "/change-password",
  requireAuth,
  credentialLimiter,
  wrap(async (req, res) => {
    const body = changePwSchema.parse(req.body);
    if (!verifyPassword(body.currentPassword, req.user.password_hash)) {
      throw unauthorized("Current password is incorrect", "bad_credentials");
    }
    const problem = passwordProblem(body.newPassword);
    if (problem) throw badRequest(`Password ${problem}`, "weak_password");

    getDb().prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(body.newPassword), req.user.id);
    // Changing a password signs out every other device.
    revokeAllForUser(req.user.id);
    audit(req.householdId, req.user.id, "auth.password.changed", "", req.ip);

    const user = findUserById(req.user.id);
    const session = issueSession(res, user, req);
    res.json({ user: publicUser(user), ...session });
  }),
);

/* ------------------------------------------- account deletion (App Review 5.1.1(v)) */

/**
 * Permanent, immediate deletion of the caller's account. An admin cannot delete
 * the last remaining admin — that would orphan the household.
 */
authRouter.delete(
  "/account",
  requireAuth,
  wrap(async (req, res) => {
    const d = getDb();
    const me = req.user;

    if (me.role === "admin") {
      const { count } = d
        .prepare(`SELECT COUNT(*) AS count FROM users WHERE household_id = ? AND role = 'admin' AND disabled_at IS NULL`)
        .get(me.household_id);
      if (count <= 1) {
        throw badRequest(
          "You are the only admin. Promote another member to admin before deleting your account.",
          "last_admin",
        );
      }
    }

    audit(me.household_id, me.id, "auth.account.deleted", me.email, req.ip);
    revokeAllForUser(me.id);
    // Items keep their text but lose the personal reference; lists/notifications cascade.
    d.prepare(`UPDATE items SET requested_by = NULL, purchased_by = NULL WHERE household_id = ? AND (requested_by = ? OR purchased_by = ?)`)
      .run(me.household_id, me.id, me.id);
    d.prepare(`UPDATE lists SET shopper_id = NULL WHERE household_id = ? AND shopper_id = ?`).run(me.household_id, me.id);
    d.prepare(`DELETE FROM users WHERE id = ?`).run(me.id);

    clearRefreshCookie(res);
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------- household */

/** Invite codes. Admin only — this is the mechanism that gates who can join. */
const inviteSchema = z.object({
  email: z.string().email().max(254).optional(),
  role: z.enum(["member", "admin"]).default("member"),
  expiresInDays: z.coerce.number().int().min(0).max(365).optional(),
});

authRouter.post(
  "/household/invites",
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const body = inviteSchema.parse(req.body ?? {});
    const code = makeInviteCode();
    // Distinguish "no expiry requested" (undefined) from "expire immediately" (0).
    // A truthiness check here would turn 0 into a PERMANENT invite, which is the
    // wrong direction to fail.
    const expiresAt = body.expiresInDays == null ? null : now() + body.expiresInDays * 864e5;
    const id = createInvite({
      householdId: req.householdId,
      code,
      email: body.email?.trim() ?? null,
      role: body.role,
      createdBy: req.user.id,
      expiresAt,
    });
    audit(req.householdId, req.user.id, "invite.created", `id=${id} email=${body.email ?? "any"}`, req.ip);
    // The plaintext code is returned exactly once; only its hash is stored.
    res.status(201).json({ id, code, email: body.email ?? null, role: body.role, expiresAt });
  }),
);

authRouter.get(
  "/household/invites",
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const nowTs = now();
    res.json({
      invites: listInvites(req.householdId).map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        createdAt: i.created_at,
        expiresAt: i.expires_at,
        usedAt: i.used_at,
        revokedAt: i.revoked_at,
        state: i.used_at ? "used" : i.revoked_at ? "revoked" : i.expires_at && i.expires_at < nowTs ? "expired" : "open",
      })),
    });
  }),
);

authRouter.delete(
  "/household/invites/:id",
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const ok = revokeInvite(req.householdId, req.params.id);
    if (!ok) throw badRequest("Invite not found or already used", "invite_not_revocable");
    audit(req.householdId, req.user.id, "invite.revoked", req.params.id, req.ip);
    res.json({ ok: true });
  }),
);

authRouter.get(
  "/household/members",
  requireAuth,
  wrap(async (req, res) => {
    const members = getDb()
      .prepare(
        `SELECT id, name, email, role, created_at, last_login_at, disabled_at
         FROM users WHERE household_id = ? ORDER BY created_at ASC`,
      )
      .all(req.householdId);
    res.json({
      members: members.map((m) => ({
        id: m.id,
        name: m.name,
        email: m.email,
        role: m.role,
        createdAt: m.created_at,
        lastLoginAt: m.last_login_at,
        disabled: !!m.disabled_at,
        isMe: m.id === req.user.id,
      })),
    });
  }),
);

/** Admin can disable (not delete) another member — this is how access is withdrawn. */
authRouter.post(
  "/household/members/:id/disable",
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const d = getDb();
    const target = d.prepare(`SELECT * FROM users WHERE id = ? AND household_id = ?`).get(req.params.id, req.householdId);
    if (!target) throw badRequest("Member not found", "no_such_member");
    if (target.id === req.user.id) throw badRequest("You cannot disable your own account", "self_disable");
    if (target.role === "admin") {
      const { count } = d
        .prepare(`SELECT COUNT(*) AS count FROM users WHERE household_id = ? AND role='admin' AND disabled_at IS NULL`)
        .get(req.householdId);
      if (count <= 1) throw badRequest("Cannot disable the only admin", "last_admin");
    }
    d.prepare(`UPDATE users SET disabled_at = ? WHERE id = ?`).run(now(), target.id);
    revokeAllForUser(target.id);
    audit(req.householdId, req.user.id, "member.disabled", target.id, req.ip);
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/household/members/:id/enable",
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const d = getDb();
    const target = d.prepare(`SELECT * FROM users WHERE id = ? AND household_id = ?`).get(req.params.id, req.householdId);
    if (!target) throw badRequest("Member not found", "no_such_member");
    d.prepare(`UPDATE users SET disabled_at = NULL WHERE id = ?`).run(target.id);
    audit(req.householdId, req.user.id, "member.enabled", target.id, req.ip);
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/household/members/:id/role",
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const { role } = z.object({ role: z.enum(["member", "admin"]) }).parse(req.body ?? {});
    const d = getDb();
    const target = d.prepare(`SELECT * FROM users WHERE id = ? AND household_id = ?`).get(req.params.id, req.householdId);
    if (!target) throw badRequest("Member not found", "no_such_member");
    if (target.role === "admin" && role === "member") {
      const { count } = d
        .prepare(`SELECT COUNT(*) AS count FROM users WHERE household_id = ? AND role='admin' AND disabled_at IS NULL`)
        .get(req.householdId);
      if (count <= 1) throw badRequest("Cannot demote the only admin", "last_admin");
    }
    d.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, target.id);
    audit(req.householdId, req.user.id, "member.role", `${target.id}->${role}`, req.ip);
    res.json({ ok: true });
  }),
);

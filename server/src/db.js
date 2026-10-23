import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { randomToken, sha256 } from "./crypto.js";

/**
 * Single-file SQLite via Node's built-in driver. Household data here is small
 * (tens of users, hundreds of items) so this is comfortably fast and removes an
 * entire class of deployment problems. The repository functions below are the
 * only place SQL is written, so swapping to Postgres is contained.
 */

let db;

export function getDb() {
  if (db) return db;
  if (config.databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(config.databasePath)), { recursive: true });
  }
  db = new DatabaseSync(config.databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS households (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      budget      REAL NOT NULL DEFAULT 0,
      invite_code_hash TEXT,              -- bootstrap code, nullable once claimed
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      email         TEXT NOT NULL,
      email_lower   TEXT NOT NULL,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'member',   -- 'admin' | 'member'
      disabled_at   INTEGER,
      created_at    INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users(email_lower);
    CREATE INDEX IF NOT EXISTS ix_users_household ON users(household_id);

    CREATE TABLE IF NOT EXISTS invites (
      id           TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      code_hash    TEXT NOT NULL,
      email        TEXT,                    -- optional: bind a code to one address
      role         TEXT NOT NULL DEFAULT 'member',
      created_by   TEXT,
      expires_at   INTEGER,
      used_at      INTEGER,
      used_by      TEXT,
      revoked_at   INTEGER,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_invites_household ON invites(household_id);

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id           TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash   TEXT NOT NULL UNIQUE,
      user_agent   TEXT,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      revoked_at   INTEGER,
      rotated_to   TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_refresh_user ON refresh_tokens(user_id);

    CREATE TABLE IF NOT EXISTS lists (
      id            TEXT PRIMARY KEY,
      household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      week          INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'archived'
      store         TEXT,
      shopper_id    TEXT,
      created_at    INTEGER NOT NULL,
      ended_at      INTEGER,
      receipt_total REAL,
      image         TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_lists_household ON lists(household_id, status);

    CREATE TABLE IF NOT EXISTS items (
      id            TEXT PRIMARY KEY,
      household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      list_id       TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      qty           REAL NOT NULL DEFAULT 1,
      unit          TEXT NOT NULL DEFAULT 'قطعة',
      price         REAL NOT NULL DEFAULT 0,
      actual_price  REAL,
      store         TEXT,
      category      TEXT NOT NULL DEFAULT 'other',
      requested_by  TEXT,
      note          TEXT,
      image         TEXT,
      purchased     INTEGER NOT NULL DEFAULT 0,
      purchased_by  TEXT,
      purchased_at  INTEGER,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_items_list ON items(list_id);
    CREATE INDEX IF NOT EXISTS ix_items_household ON items(household_id);

    CREATE TABLE IF NOT EXISTS notifications (
      id           TEXT PRIMARY KEY,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,  -- null = whole household
      type         TEXT NOT NULL DEFAULT 'list',
      text         TEXT NOT NULL,
      ts           INTEGER NOT NULL,
      read_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_notif_household ON notifications(household_id, ts DESC);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id            TEXT PRIMARY KEY,
      household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint      TEXT NOT NULL UNIQUE,
      p256dh        TEXT NOT NULL,
      auth          TEXT NOT NULL,
      user_agent    TEXT,
      created_at    INTEGER NOT NULL,
      last_success_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_push_household ON push_subscriptions(household_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id TEXT,
      user_id      TEXT,
      action       TEXT NOT NULL,
      detail       TEXT,
      ip           TEXT,
      ts           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_audit_household ON audit_log(household_id, ts DESC);
  `);
}

/* ------------------------------------------------------------------ helpers */

export const newId = (prefix) => `${prefix}_${randomToken(9)}`;
export const now = () => Date.now();

export function audit(householdId, userId, action, detail, ip) {
  getDb()
    .prepare(
      `INSERT INTO audit_log (household_id, user_id, action, detail, ip, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(householdId ?? null, userId ?? null, action, detail ?? null, ip ?? null, now());
}

/** Adds one in-app notification. `userId` null means the whole household. */
export function addNotification(householdId, { userId = null, type = "list", text }) {
  const id = newId("n");
  getDb()
    .prepare(
      `INSERT INTO notifications (id, household_id, user_id, type, text, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, householdId, userId, type, text, now());
  return id;
}

/* ------------------------------------------------- bootstrap a new household */

export function createHousehold({ name, adminEmail, adminName, passwordHash, inviteCodeHash, budget = 0 }) {
  const d = getDb();
  const hid = newId("hh");
  const uid = newId("u");
  const ts = now();
  d.exec("BEGIN");
  try {
    d.prepare(
      `INSERT INTO households (id, name, budget, invite_code_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(hid, name, budget, inviteCodeHash ?? null, ts);
    d.prepare(
      `INSERT INTO users (id, household_id, email, email_lower, name, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'admin', ?)`,
    ).run(uid, hid, adminEmail, adminEmail.toLowerCase(), adminName, passwordHash, ts);
    d.exec("COMMIT");
    return { householdId: hid, userId: uid };
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function findUserByEmail(email) {
  return (
    getDb()
      .prepare(`SELECT * FROM users WHERE email_lower = ?`)
      .get(String(email).toLowerCase()) ?? null
  );
}

export function findUserById(id) {
  return getDb().prepare(`SELECT * FROM users WHERE id = ?`).get(id) ?? null;
}

export function householdOf(userId) {
  return getDb().prepare(`SELECT * FROM households WHERE id = ?`).get(userId) ?? null;
}

export function getHousehold(id) {
  return getDb().prepare(`SELECT * FROM households WHERE id = ?`).get(id) ?? null;
}

export function isAdmin(user) {
  return user?.role === "admin";
}

/* ------------------------------------------------------------------ invites */

export function createInvite({ householdId, code, email, role, createdBy, expiresAt }) {
  const d = getDb();
  const id = newId("inv");
  d.prepare(
    `INSERT INTO invites (id, household_id, code_hash, email, role, created_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, householdId, sha256(code), email ?? null, role ?? "member", createdBy ?? null, expiresAt ?? null, now());
  return id;
}

/** Finds a redeemable invite for a code, optionally bound to an email address. */
export function findRedeemableInvite(code, emailLower) {
  const inv = getDb()
    .prepare(`SELECT * FROM invites WHERE code_hash = ?`)
    .get(sha256(code));
  if (!inv) return { ok: false, reason: "invalid" };
  if (inv.revoked_at) return { ok: false, reason: "revoked" };
  if (inv.used_at) return { ok: false, reason: "used" };
  if (inv.expires_at && inv.expires_at < now()) return { ok: false, reason: "expired" };
  // A code bound to an address only works for that address.
  if (inv.email && inv.email.toLowerCase() !== emailLower) return { ok: false, reason: "email_mismatch" };
  return { ok: true, invite: inv };
}

export function redeemInvite(inviteId, userId) {
  getDb()
    .prepare(`UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL`)
    .run(now(), userId, inviteId);
}

export function listInvites(householdId) {
  return getDb()
    .prepare(`SELECT * FROM invites WHERE household_id = ? ORDER BY created_at DESC`)
    .all(householdId);
}

export function revokeInvite(householdId, inviteId) {
  const r = getDb()
    .prepare(`UPDATE invites SET revoked_at = ? WHERE id = ? AND household_id = ? AND used_at IS NULL`)
    .run(now(), inviteId, householdId);
  return r.changes > 0;
}

/* ------------------------------------------------------------ refresh tokens */

export function storeRefreshToken({ householdId, userId, token, userAgent, ttlDays }) {
  const id = newId("rt");
  getDb()
    .prepare(
      `INSERT INTO refresh_tokens (id, household_id, user_id, token_hash, user_agent, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, householdId, userId, sha256(token), (userAgent || "").slice(0, 200), now(), now() + ttlDays * 864e5);
  return id;
}

export function consumeRefreshToken(token) {
  const d = getDb();
  const row = d.prepare(`SELECT * FROM refresh_tokens WHERE token_hash = ?`).get(sha256(token));
  if (!row) return { ok: false, reason: "unknown" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (row.expires_at < now()) return { ok: false, reason: "expired" };
  return { ok: true, row };
}

export function rotateRefreshToken({ oldId, newToken, householdId, userId, userAgent, ttlDays }) {
  const d = getDb();
  const nid = newId("rt");
  d.exec("BEGIN");
  try {
    d.prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now(), oldId);
    d.prepare(
      `INSERT INTO refresh_tokens (id, household_id, user_id, token_hash, user_agent, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(nid, householdId, userId, sha256(newToken), (userAgent || "").slice(0, 200), now(), now() + ttlDays * 864e5);
    d.prepare(`UPDATE refresh_tokens SET rotated_to = ? WHERE id = ?`).run(nid, oldId);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return nid;
}

export function revokeRefreshToken(id) {
  getDb().prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now(), id);
}

export function revokeAllForUser(userId) {
  getDb().prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).run(now(), userId);
}

export function closeDb() {
  if (db) { db.close(); db = undefined; }
}

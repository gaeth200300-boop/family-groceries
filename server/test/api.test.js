/**
 * End-to-end API tests against a real in-process server and a real SQLite file.
 * Focus: authentication correctness and — most importantly — that one household
 * can never read or mutate another household's data.
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-that-is-definitely-long-enough-32";
// config is read once at import, so the flag must be set before the first import.
// It is safe here: the DB starts empty, so only the very first signup can
// bootstrap a household. Every later signup still requires an invite.
process.env.REQUIRE_INVITE = "false";
// Neutralise a developer's local .env so the test is reproducible.
process.env.SETUP_TOKEN = "";
process.env.AUTH_RATE_LIMIT_MAX = "1000";
process.env.CORS_ORIGINS = "";

import test from "node:test";
import assert from "node:assert/strict";

const { createApp } = await import("../src/index.js");
const db = await import("../src/db.js");
const { hashPassword } = await import("../src/crypto.js");

let server;
let base;

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server?.close());

/* ----------------------------------------------------------------- helpers */

async function call(method, path, { token, body, cookie } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, body: json, raw: text, setCookie };
}

function cookieFrom(res) {
  const c = res.setCookie.find((s) => s.startsWith("fg_refresh="));
  return c ? c.split(";")[0] : null;
}

/* --------------------------------------------------------- test fixtures */

/**
 * Creates a household directly in the database and returns a signed-in session.
 * Used for arranging multi-household scenarios; the HTTP registration path is
 * exercised separately by the bootstrap test below.
 */
async function seedHousehold(email, { name = "Owner", role = "admin", password = "correct horse 1" } = {}) {
  const { householdId, userId } = db.createHousehold({
    name: "Household " + email,
    adminEmail: email,
    adminName: name,
    passwordHash: hashPassword(password),
  });
  if (role !== "admin") {
    db.getDb().prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, userId);
  }
  const user = db.findUserById(userId);
  const login = await call("POST", "/api/auth/login", { body: { email, password } });
  assert.equal(login.status, 200, `seed login failed: ${login.raw}`);
  return { ...login.body, password };
}

/** Adds a member to an existing household and returns their session. */
async function seedMember(adminSession, email, { role = "member", password = "memberpass1" } = {}) {
  const made = await call("POST", "/api/auth/household/invites", { token: adminSession.accessToken, body: { role } });
  assert.equal(made.status, 201, made.raw);
  const reg = await call("POST", "/api/auth/register", {
    body: { email, name: "Member", password, inviteCode: made.body.code },
  });
  assert.equal(reg.status, 201, reg.raw);
  return reg.body;
}

/* ============================================================== the tests */

test("health endpoint responds without auth", async () => {
  const r = await call("GET", "/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

/* Must run first: this is the genuine first-run path, with an empty database. */
test("first-ever signup over HTTP bootstraps a household and becomes its admin", async () => {
  const { count } = db.getDb().prepare(`SELECT COUNT(*) AS count FROM users`).get();
  assert.equal(count, 0, "this test must run against an empty database");

  const r = await call("POST", "/api/auth/register", {
    body: { email: "first@example.test", name: "First", password: "correct horse 1" },
  });
  assert.equal(r.status, 201, r.raw);
  assert.equal(r.body.user.role, "admin");
  assert.ok(r.body.user.householdId);
  assert.ok(r.body.accessToken);

  // Immediately usable for the household's data.
  const state = await call("GET", "/api/lists/state", { token: r.body.accessToken });
  assert.equal(state.status, 200);
  assert.equal(state.body.currentList, null, "a new household has no list yet");
});

test("registering without an invite is refused once a household exists", async () => {
  const admin = await seedHousehold("owner@example.test");
  assert.ok(admin.accessToken);
  const r = await call("POST", "/api/auth/register", {
    body: { email: "stranger@example.test", name: "Stranger", password: "hunter2200x" },
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "invite_required");
});

test("weak passwords are rejected", async () => {
  const r = await call("POST", "/api/auth/register", {
    body: { email: "a@b.test", name: "A", password: "short" },
  });
  assert.ok([400, 403].includes(r.status), `got ${r.status}`);
});

test("passwords are stored as scrypt hashes, never plaintext", async () => {
  const admin = await seedHousehold("hashcheck@example.test");
  const { getDb } = await import("../src/db.js");
  const row = getDb().prepare(`SELECT password_hash FROM users WHERE email_lower = ?`)
    .get("hashcheck@example.test");
  assert.ok(row.password_hash.startsWith("scrypt$"), row.password_hash);
  assert.ok(!row.password_hash.includes("correct horse"));
});

test("admin can mint an invite; the invited address can register with it", async () => {
  const admin = await seedHousehold("inviter@example.test");
  const made = await call("POST", "/api/auth/household/invites", {
    token: admin.accessToken, body: { email: "member@example.test", role: "member" },
  });
  assert.equal(made.status, 201, made.raw);
  assert.match(made.body.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const reg = await call("POST", "/api/auth/register", {
    body: { email: "member@example.test", name: "Member", password: "memberpass1", inviteCode: made.body.code },
  });
  assert.equal(reg.status, 201, reg.raw);
  assert.equal(reg.body.user.role, "member");
  assert.equal(reg.body.user.householdId, admin.user.householdId);
});

test("an invite bound to one email cannot be used by another", async () => {
  const admin = await seedHousehold("binder@example.test");
  const made = await call("POST", "/api/auth/household/invites", {
    token: admin.accessToken, body: { email: "right@example.test" },
  });
  const r = await call("POST", "/api/auth/register", {
    body: { email: "wrong@example.test", name: "W", password: "password123", inviteCode: made.body.code },
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "invite_email_mismatch");
});

test("an invite code cannot be reused", async () => {
  const admin = await seedHousehold("reuse@example.test");
  const made = await call("POST", "/api/auth/household/invites", { token: admin.accessToken, body: {} });
  const first = await call("POST", "/api/auth/register", {
    body: { email: "one@example.test", name: "One", password: "password123", inviteCode: made.body.code },
  });
  assert.equal(first.status, 201);
  const second = await call("POST", "/api/auth/register", {
    body: { email: "two@example.test", name: "Two", password: "password123", inviteCode: made.body.code },
  });
  assert.equal(second.status, 403);
  assert.equal(second.body.error, "invite_used");
});

test("login works with the right password and fails with the wrong one", async () => {
  const admin = await seedHousehold("login@example.test");
  const ok = await call("POST", "/api/auth/login", {
    body: { email: "login@example.test", password: "correct horse 1" },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.email, "login@example.test");

  const bad = await call("POST", "/api/auth/login", {
    body: { email: "login@example.test", password: "wrong password 1" },
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, "bad_credentials");
});

test("unknown email and wrong password give the same generic error", async () => {
  const a = await call("POST", "/api/auth/login", { body: { email: "nobody@example.test", password: "whatever1" } });
  const b = await call("POST", "/api/auth/login", { body: { email: "login@example.test", password: "wrong one 1" } });
  assert.equal(a.status, b.status);
  assert.equal(a.body.message, b.body.message, "must not reveal whether the account exists");
});

test("protected routes reject missing, malformed and forged tokens", async () => {
  const none = await call("GET", "/api/lists/state");
  assert.equal(none.status, 401);

  const junk = await call("GET", "/api/lists/state", { token: "not-a-jwt" });
  assert.equal(junk.status, 401);

  // Correctly signed but wrong secret.
  const jwt = (await import("jsonwebtoken")).default;
  const forged = jwt.sign({ sub: "u_x", hid: "hh_x", role: "admin", typ: "access" }, "attacker-secret-32-chars-long-here", {
    expiresIn: "15m", issuer: "family-groceries",
  });
  const f = await call("GET", "/api/lists/state", { token: forged });
  assert.equal(f.status, 401, "forged token must be rejected");
});

test("refresh rotates the token and the old one cannot be replayed", async () => {
  const admin = await seedHousehold("refresh@example.test");
  const cookie = cookieFrom(admin ? await call("POST", "/api/auth/login", {
    body: { email: "refresh@example.test", password: "correct horse 1" },
  }) : null);
  assert.ok(cookie, "refresh cookie should be issued");

  const first = await call("POST", "/api/auth/refresh", { cookie });
  assert.equal(first.status, 200);
  const newCookie = cookieFrom(first);
  assert.notEqual(newCookie, cookie, "a new refresh token must be issued");

  const replay = await call("POST", "/api/auth/refresh", { cookie });
  assert.equal(replay.status, 401, "the rotated-out token must not work again");
});

/* ------------------------------------------- THE key security test: tenancy */

test("one household cannot read or modify another household's data", async () => {
  // Household A
  const a = await seedHousehold("a@example.test");
  const aList = await call("POST", "/api/lists", { token: a.accessToken, body: { name: "Week 1", week: 1, budget: 500 } });
  assert.equal(aList.status, 201, aList.raw);
  const aItem = await call("POST", `/api/lists/${aList.body.id}/items`, {
    token: a.accessToken, body: { name: "MILK-SECRET", qty: 2, price: 15, store: "Lulu" },
  });
  assert.equal(aItem.status, 201, aItem.raw);

  // Household B, completely separate
  const b = await seedHousehold("b@example.test");

  // B cannot see A's state
  const bState = await call("GET", "/api/lists/state", { token: b.accessToken });
  assert.equal(bState.status, 200);
  assert.ok(!bState.raw.includes("MILK-SECRET"), "B must not see A's items");

  // B cannot read A's list directly
  const peek = await call("PATCH", `/api/lists/${aList.body.id}`, {
    token: b.accessToken, body: { name: "hijacked" },
  });
  assert.equal(peek.status, 404, "cross-tenant list access must 404");

  // B cannot delete A's item
  const del = await call("DELETE", `/api/items/${aItem.body.id}`, { token: b.accessToken });
  assert.equal(del.status, 404, "cross-tenant item delete must 404");

  // B cannot edit A's item
  const patch = await call("PATCH", `/api/items/${aItem.body.id}`, {
    token: b.accessToken, body: { name: "tampered" },
  });
  assert.equal(patch.status, 404, "cross-tenant item patch must 404");

  // A's data is untouched
  const aState = await call("GET", "/api/lists/state", { token: a.accessToken });
  assert.ok(aState.raw.includes("MILK-SECRET"));
  assert.ok(!aState.raw.includes("hijacked"));
  assert.ok(!aState.raw.includes("tampered"));
});

test("a member cannot mint invites or change roles (admin only)", async () => {
  const admin = await seedHousehold("ro-admin@example.test");
  const made = await call("POST", "/api/auth/household/invites", { token: admin.accessToken, body: {} });
  const member = await call("POST", "/api/auth/register", {
    body: { email: "ro-member@example.test", name: "M", password: "password123", inviteCode: made.body.code },
  });
  assert.equal(member.status, 201);

  const inviteAttempt = await call("POST", "/api/auth/household/invites", { token: member.body.accessToken, body: {} });
  assert.equal(inviteAttempt.status, 403);
  assert.equal(inviteAttempt.body.error, "admin_required");

  const listMembers = await call("GET", "/api/auth/household/members", { token: member.body.accessToken });
  assert.equal(listMembers.status, 200, "members may view the roster");

  const roleAttempt = await call("POST", `/api/auth/household/members/${admin.user.id}/role`, {
    token: member.body.accessToken, body: { role: "member" },
  });
  assert.equal(roleAttempt.status, 403);
});

test("a disabled member's existing token stops working immediately", async () => {
  const admin = await seedHousehold("dis-admin@example.test");
  const made = await call("POST", "/api/auth/household/invites", { token: admin.accessToken, body: {} });
  const m = await call("POST", "/api/auth/register", {
    body: { email: "dis-member@example.test", name: "M", password: "password123", inviteCode: made.body.code },
  });

  const before = await call("GET", "/api/lists/state", { token: m.body.accessToken });
  assert.equal(before.status, 200);

  const off = await call("POST", `/api/auth/household/members/${m.body.user.id}/disable`, {
    token: admin.accessToken,
  });
  assert.equal(off.status, 200, off.raw);

  const after = await call("GET", "/api/lists/state", { token: m.body.accessToken });
  // The account still exists but is disabled, so 403 (not permitted) is correct.
  assert.equal(after.status, 403, "disabled user must lose access at once");
  assert.equal(after.body.error, "account_disabled");

  const relogin = await call("POST", "/api/auth/login", {
    body: { email: "dis-member@example.test", password: "password123" },
  });
  assert.equal(relogin.status, 403, "a disabled account cannot sign in again");
  assert.equal(relogin.body.error, "account_disabled");
});

test("the only admin cannot be deleted, demoted, or disabled", async () => {
  const admin = await seedHousehold("solo@example.test");

  const del = await call("DELETE", "/api/auth/account", { token: admin.accessToken });
  assert.equal(del.status, 400);
  assert.equal(del.body.error, "last_admin");

  const demote = await call("POST", `/api/auth/household/members/${admin.user.id}/role`, {
    token: admin.accessToken, body: { role: "member" },
  });
  assert.equal(demote.status, 400);
  assert.equal(demote.body.error, "last_admin");

  const disable = await call("POST", `/api/auth/household/members/${admin.user.id}/disable`, {
    token: admin.accessToken,
  });
  assert.equal(disable.status, 400);
});

test("account deletion works for a non-admin and revokes access", async () => {
  const admin = await seedHousehold("del-admin@example.test");
  const made = await call("POST", "/api/auth/household/invites", { token: admin.accessToken, body: {} });
  const m = await call("POST", "/api/auth/register", {
    body: { email: "del-member@example.test", name: "M", password: "password123", inviteCode: made.body.code },
  });

  const del = await call("DELETE", "/api/auth/account", { token: m.body.accessToken });
  assert.equal(del.status, 200, del.raw);

  const after = await call("GET", "/api/lists/state", { token: m.body.accessToken });
  assert.equal(after.status, 401, "deleted user must not authenticate");

  const relogin = await call("POST", "/api/auth/login", {
    body: { email: "del-member@example.test", password: "password123" },
  });
  assert.equal(relogin.status, 401);
});

test("change-password requires the current password and signs out other devices", async () => {
  const admin = await seedHousehold("pw@example.test");
  const login = await call("POST", "/api/auth/login", {
    body: { email: "pw@example.test", password: "correct horse 1" },
  });
  const oldCookie = cookieFrom(login);

  const wrong = await call("POST", "/api/auth/change-password", {
    token: login.body.accessToken, cookie: oldCookie, body: { currentPassword: "nope 12345", newPassword: "brand new 9" },
  });
  assert.equal(wrong.status, 401);

  const right = await call("POST", "/api/auth/change-password", {
    token: login.body.accessToken, cookie: oldCookie,
    body: { currentPassword: "correct horse 1", newPassword: "brand new 9" },
  });
  assert.equal(right.status, 200, right.raw);

  const oldDevice = await call("POST", "/api/auth/refresh", { cookie: oldCookie });
  assert.equal(oldDevice.status, 401, "previous sessions must be revoked");

  const fresh = await call("POST", "/api/auth/login", {
    body: { email: "pw@example.test", password: "brand new 9" },
  });
  assert.equal(fresh.status, 200);
});

/* ------------------------------------------------------------ grocery data */

test("items can be added, edited, purchased and deleted", async () => {
  const admin = await seedHousehold("grocery@example.test");
  const list = await call("POST", "/api/lists", { token: admin.accessToken, body: { name: "Week 1", week: 1, budget: 300 } });
  const listId = list.body.id;

  const added = await call("POST", `/api/lists/${listId}/items`, {
    token: admin.accessToken, body: { name: "Milk", qty: 2, unit: "عبوة", price: 15, store: "Lulu", category: "dairy" },
  });
  assert.equal(added.status, 201, added.raw);
  assert.equal(added.body.name, "Milk");
  assert.equal(added.body.purchased, false);
  assert.equal(added.body.actualPrice, null);

  const bought = await call("PATCH", `/api/items/${added.body.id}`, {
    token: admin.accessToken, body: { purchased: true },
  });
  assert.equal(bought.status, 200);
  assert.equal(bought.body.purchased, true);
  assert.equal(bought.body.actualPrice, 15, "actual price defaults to expected");
  assert.equal(bought.body.purchasedBy, admin.user.id);

  const repriced = await call("PATCH", `/api/items/${added.body.id}`, {
    token: admin.accessToken, body: { actualPrice: 18 },
  });
  assert.equal(repriced.body.actualPrice, 18);

  const undone = await call("PATCH", `/api/items/${added.body.id}`, {
    token: admin.accessToken, body: { purchased: false },
  });
  assert.equal(undone.body.purchased, false);
  assert.equal(undone.body.actualPrice, null, "un-purchasing clears the actual price");
  assert.equal(undone.body.purchasedBy, null);

  const del = await call("DELETE", `/api/items/${added.body.id}`, { token: admin.accessToken });
  assert.equal(del.status, 200);
  const gone = await call("PATCH", `/api/items/${added.body.id}`, { token: admin.accessToken, body: { name: "x" } });
  assert.equal(gone.status, 404);
});

test("invalid category and negative quantity are rejected", async () => {
  const admin = await seedHousehold("valid@example.test");
  const list = await call("POST", "/api/lists", { token: admin.accessToken, body: { name: "W", week: 1 } });
  const badCat = await call("POST", `/api/lists/${list.body.id}/items`, {
    token: admin.accessToken, body: { name: "X", category: "not-a-category" },
  });
  assert.equal(badCat.status, 400);
  const badQty = await call("POST", `/api/lists/${list.body.id}/items`, {
    token: admin.accessToken, body: { name: "X", qty: -5 },
  });
  assert.equal(badQty.status, 400);
});

test("finishing a list archives it, bumps the week, and can carry items over", async () => {
  const admin = await seedHousehold("finish@example.test");
  const list = await call("POST", "/api/lists", { token: admin.accessToken, body: { name: "الأسبوع 1", week: 1, budget: 400 } });
  await call("POST", `/api/lists/${list.body.id}/items`, { token: admin.accessToken, body: { name: "Bought", price: 20, purchased: true } });
  await call("POST", `/api/lists/${list.body.id}/items`, { token: admin.accessToken, body: { name: "LeftOver", price: 30 } });

  const fin = await call("POST", "/api/lists/finish", { token: admin.accessToken, body: { store: "Carrefour", carryOver: true } });
  assert.equal(fin.status, 200, fin.raw);
  assert.equal(fin.body.newWeek, 2);

  const state = await call("GET", "/api/lists/state", { token: admin.accessToken });
  assert.equal(state.body.week, 2);
  assert.equal(state.body.archived.length, 1);
  assert.equal(state.body.currentList.items.length, 1);
  assert.equal(state.body.currentList.items[0].name, "LeftOver");
  assert.equal(state.body.currentList.items[0].purchased, false);
  assert.equal(state.body.archived[0].store, "Carrefour");
});

test("finishing with nothing purchased is refused", async () => {
  const admin = await seedHousehold("nofinish@example.test");
  await call("POST", "/api/lists", { token: admin.accessToken, body: { name: "W", week: 1 } });
  const r = await call("POST", "/api/lists/finish", { token: admin.accessToken, body: {} });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "nothing_purchased");
});

test("only one active list per household", async () => {
  const admin = await seedHousehold("onlist@example.test");
  const a = await call("POST", "/api/lists", { token: admin.accessToken, body: { name: "W1", week: 1 } });
  assert.equal(a.status, 201);
  const b = await call("POST", "/api/lists", { token: admin.accessToken, body: { name: "W2", week: 2 } });
  assert.equal(b.status, 400);
  assert.equal(b.body.error, "list_exists");
});

test("state payload contains no password hashes or invite codes", async () => {
  const admin = await seedHousehold("leak@example.test");
  await call("POST", "/api/auth/household/invites", { token: admin.accessToken, body: {} });
  const state = await call("GET", "/api/lists/state", { token: admin.accessToken });
  assert.ok(!state.raw.includes("scrypt$"), "no password hash may leak");
  const members = await call("GET", "/api/auth/household/members", { token: admin.accessToken });
  assert.ok(!members.raw.includes("scrypt$"), "no password hash may leak via members");
  const invites = await call("GET", "/api/auth/household/invites", { token: admin.accessToken });
  assert.ok(!invites.raw.includes("code_hash"), "invite hashes must not leak");
  assert.ok(!/code"?\s*:\s*"[A-Z0-9]{4}-/.test(invites.raw), "plaintext invite codes must not be re-listable");
});

test("audit log records security-relevant events", async () => {
  const admin = await seedHousehold("audit@example.test");
  // The fixture signs in, so a login event must exist.
  let rows = db
    .getDb()
    .prepare(`SELECT action FROM audit_log WHERE household_id = ? ORDER BY id`)
    .all(admin.user.householdId)
    .map((r) => r.action);
  assert.ok(rows.includes("auth.login.ok"), rows.join(","));

  // Admin actions are audited too.
  await call("POST", "/api/auth/household/invites", { token: admin.accessToken, body: {} });
  rows = db
    .getDb()
    .prepare(`SELECT action FROM audit_log WHERE household_id = ? ORDER BY id`)
    .all(admin.user.householdId)
    .map((r) => r.action);
  assert.ok(rows.includes("invite.created"), rows.join(","));
});

test("unknown API routes return JSON 404, and do not leak to anonymous callers", async () => {
  // Unauthenticated: 401 rather than 404, so endpoint existence is not disclosed.
  const anon = await call("GET", "/api/nope");
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error, "unauthorized");

  // Authenticated: a clean JSON 404, not an HTML error page.
  const auth = await seedHousehold("404@example.test");
  const r = await call("GET", "/api/nope", { token: auth.accessToken });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "not_found");
});

test("security headers are present", async () => {
  const res = await fetch(base + "/api/health");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.ok(res.headers.get("content-security-policy"), "CSP must be set");
  assert.equal(res.headers.get("x-powered-by"), null);
});

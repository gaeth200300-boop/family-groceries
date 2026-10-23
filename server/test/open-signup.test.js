/**
 * Family mode: open signup (no invite code), a public names-only roster, the
 * shared 1234 access code, and short family passwords.
 *
 * These settings are OFF by default and are enabled explicitly here, matching
 * the private family .env used by the live app.
 */
import test from "node:test";
import assert from "node:assert/strict";

const SETUP_TOKEN = "open-signup-setup-token-0123456789";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "open-signup-test-secret-long-enough-32";
process.env.REQUIRE_INVITE = "true";
process.env.SETUP_TOKEN = SETUP_TOKEN;
process.env.ALLOW_OPEN_SIGNUP = "true";
process.env.FAMILY_PIN = "1234";
process.env.ALLOW_WEAK_PASSWORDS = "true";
process.env.AUTH_RATE_LIMIT_MAX = "1000";

const { createApp } = await import("../src/index.js");

let server, base;

test.before(async () => {
  const app = createApp();
  await new Promise((r) => {
    server = app.listen(0, "127.0.0.1", r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server?.close());

async function api(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw */
  }
  return { status: res.status, body: json, raw: text };
}

let owner;
let member;

test("the owner is created with the setup token", async () => {
  const r = await api("POST", "/api/auth/register", {
    email: "owner@open.test",
    name: "Owner",
    password: "correct horse 1",
    setupToken: SETUP_TOKEN,
  });
  assert.equal(r.status, 201, r.raw);
  assert.equal(r.body.user.role, "admin");
  owner = r.body.user;
});

test("a family member can join with only name, email and password (no invite)", async () => {
  const r = await api("POST", "/api/auth/register", {
    email: "noura@open.test",
    name: "نورة",
    password: "1234",
  });
  assert.equal(r.status, 201, r.raw);
  assert.equal(r.body.user.name, "نورة");
  assert.equal(r.body.user.role, "member", "open signup never creates an admin");
  member = r.body.user;
});

test("the public roster exposes names and roles, never emails", async () => {
  const r = await api("GET", "/api/auth/roster");
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.pinEnabled, true);
  assert.equal(r.body.openSignup, true);
  const names = r.body.members.map((m) => m.name);
  assert.ok(names.includes("Owner"), "owner appears in the roster");
  assert.ok(names.includes("نورة"), "new member appears in the roster");
  for (const m of r.body.members) {
    assert.ok(!("email" in m), "the public roster must not leak emails");
    assert.ok(m.id && m.name && m.role);
  }
});

test("a member can log in with a roster id and the shared 1234 code", async () => {
  const r = await api("POST", "/api/auth/login", { userId: member.id, password: "1234" });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.user.id, member.id);
  const me = await api("GET", "/api/auth/me", undefined, r.body.accessToken);
  assert.equal(me.status, 200, me.raw);
  assert.equal(me.body.user.name, "نورة");
});

test("the shared code also opens an account whose own password is different", async () => {
  const r = await api("POST", "/api/auth/login", { userId: owner.id, password: "1234" });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.user.id, owner.id);
});

test("a wrong code is rejected", async () => {
  const r = await api("POST", "/api/auth/login", { userId: owner.id, password: "9999" });
  assert.equal(r.status, 401, r.raw);
  assert.equal(r.body.error, "bad_credentials");
});

test("duplicate emails are still refused", async () => {
  const r = await api("POST", "/api/auth/register", {
    email: "noura@open.test",
    name: "نسخة",
    password: "1234",
  });
  assert.equal(r.status, 409, r.raw);
  assert.equal(r.body.error, "email_taken");
});

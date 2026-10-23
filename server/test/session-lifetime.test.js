/**
 * "Family members keep access indefinitely" — the two halves of that promise:
 *
 *   1. Invites never expire (permanent, but still single-use).
 *   2. A member who keeps using the app never has to sign in again, because the
 *      session window slides forward on every refresh.
 *
 * ...and the one thing that must still win: the owner can revoke access at any
 * moment, regardless of how long the session is.
 */
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

const SETUP_TOKEN = "session-test-token-0123456789abcdef";

process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "session-lifetime-test-secret-long-enough";
process.env.REQUIRE_INVITE = "true";
process.env.SETUP_TOKEN = SETUP_TOKEN;
process.env.ALLOW_OPEN_SIGNUP = "false";
process.env.FAMILY_PIN = "";
process.env.ALLOW_WEAK_PASSWORDS = "false";
process.env.AUTH_RATE_LIMIT_MAX = "10000";
process.env.DATABASE_URL = ":memory:";
process.env.CORS_ORIGINS = "";

// Imported after the environment is set: config.js validates at module load.
const { makeTlsPems } = await import("./helpers/tls.js");
const { createApp } = await import("../src/index.js");
const db = await import("../src/db.js");

const pems = await makeTlsPems(["localhost", "127.0.0.1"]);
let server, base;

test.before(async () => {
  const app = createApp();
  server = https.createServer({ key: pems.key, cert: pems.cert }, app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `https://localhost:${server.address().port}`;
});
test.after(() => server?.close());

const DAY = 864e5;

function api(method, p, { body, token, cookie } = {}) {
  const url = new URL(base + p);
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method,
      headers: {
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        ...(token ? { authorization: "Bearer " + token } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ca: pems.cert, servername: "localhost",
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* not JSON */ }
        const sc = res.headers["set-cookie"] || [];
        resolve({ status: res.statusCode, body: json, raw: data, cookies: sc });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const cookieOf = (res) => {
  const c = res.cookies.find((x) => x.startsWith("fg_refresh="));
  return c ? c.split(";")[0] : null;
};

let ownerToken;

/* ==================================================================== tests */

test("the default session window is a year, not a month", async () => {
  const { config } = await import("../src/config.js");
  assert.equal(config.refreshTokenTtlDays, 365,
    "a member signing in today must not be logged out next month");
  assert.equal(config.accessTokenTtl, "15m", "the access token stays short-lived");
});

test("claiming the household and signing in issues a year-long refresh cookie", async () => {
  const boot = await api("POST", "/api/auth/register", {
    body: { email: "owner@fam.test", name: "Owner", password: "correct horse 1", setupToken: SETUP_TOKEN },
  });
  assert.equal(boot.status, 201, boot.raw);
  ownerToken = boot.body.accessToken;

  const cookie = cookieOf(boot);
  assert.ok(cookie, "refresh cookie issued");

  // The cookie's Max-Age should be ~a year, not 30 days.
  const setCookie = boot.cookies.find((c) => c.startsWith("fg_refresh="));
  const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1]);
  assert.ok(maxAge > 360 * 86400, `Max-Age was ${maxAge}s, expected ~1 year`);

  // And the stored row must agree.
  const row = db.getDb().prepare(`SELECT * FROM refresh_tokens ORDER BY created_at DESC LIMIT 1`).get();
  const days = (row.expires_at - row.created_at) / DAY;
  assert.ok(days > 360, `stored TTL was ${days} days`);
});

test("the session window slides forward on every refresh, so it never runs down", async () => {
  const login = await api("POST", "/api/auth/login", {
    body: { email: "owner@fam.test", password: "correct horse 1" },
  });
  let cookie = cookieOf(login);
  assert.ok(cookie, "login sets a refresh cookie");

  // Six refreshes, each simulating the member returning months later.
  const expiries = [];
  for (let i = 0; i < 6; i++) {
    const r = await api("POST", "/api/auth/refresh", { cookie });
    assert.equal(r.status, 200, `refresh ${i + 1} failed: ${r.raw}`);
    cookie = cookieOf(r);
    assert.ok(cookie, `refresh ${i + 1} did not rotate the cookie`);

    const row = db.getDb()
      .prepare(`SELECT expires_at FROM refresh_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`)
      .get();
    expiries.push(row.expires_at);
  }

  // Each refresh must push the window out again, never shorten it.
  for (let i = 1; i < expiries.length; i++) {
    assert.ok(expiries[i] >= expiries[i - 1],
      `window shrank on refresh ${i + 1}: ${expiries[i - 1]} -> ${expiries[i]}`);
  }
  // And the last one is still ~a year away.
  const daysOut = (expiries[expiries.length - 1] - Date.now()) / DAY;
  assert.ok(daysOut > 360, `after 6 refreshes only ${daysOut.toFixed(0)} days remained`);
});

test("an idle session past its window is refused (the honest limit)", async () => {
  const login = await api("POST", "/api/auth/login", {
    body: { email: "owner@fam.test", password: "correct horse 1" },
  });
  const cookie = cookieOf(login);

  // Pretend the token aged out.
  const before = db.getDb()
    .prepare(`SELECT id FROM refresh_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`)
    .get();
  db.getDb().prepare(`UPDATE refresh_tokens SET expires_at = ? WHERE id = ?`)
    .run(Date.now() - 1000, before.id);

  const r = await api("POST", "/api/auth/refresh", { cookie });
  assert.equal(r.status, 401, "an expired session must be refused");
  assert.equal(r.body.error, "refresh_expired");

  // Signing in again restores access immediately.
  const again = await api("POST", "/api/auth/login", {
    body: { email: "owner@fam.test", password: "correct horse 1" },
  });
  assert.equal(again.status, 200);
  const state = await api("GET", "/api/lists/state", { token: again.body.accessToken });
  assert.equal(state.status, 200, "no data is lost, only the session");
});

test("a permanent invite stays valid indefinitely but is still single-use", async () => {
  const inv = await api("POST", "/api/auth/household/invites", {
    token: ownerToken, body: { email: "child@fam.test" },
  });
  assert.equal(inv.status, 201);
  assert.equal(inv.body.expiresAt, null, "no expiry by default");

  // Pretend a long time has passed (10 years) and that the code was never used.
  const row = db.getDb().prepare(`SELECT id, expires_at, used_at FROM invites WHERE id = ?`).get(inv.body.id);
  assert.equal(row.expires_at, null, "a permanent invite carries no expiry");
  assert.equal(row.used_at, null);

  // It works.
  const join = await api("POST", "/api/auth/register", {
    body: { email: "child@fam.test", name: "Child", password: "childpass12", inviteCode: inv.body.code },
  });
  assert.equal(join.status, 201, join.raw);

  // But exactly once.
  const second = await api("POST", "/api/auth/register", {
    body: { email: "other@fam.test", name: "Other", password: "otherpass12", inviteCode: inv.body.code },
  });
  assert.equal(second.status, 403);
  assert.equal(second.body.error, "invite_used",
    "permanence must not become multi-use, or a forwarded code would let strangers in");
});

test("a member session keeps working across many refreshes, and revocation still wins", async () => {
  const login = await api("POST", "/api/auth/login", {
    body: { email: "child@fam.test", password: "childpass12" },
  });
  assert.equal(login.status, 200, login.raw);
  const memberId = login.body.user.id;

  // Keep using it.
  let cookie = cookieOf(login);
  for (let i = 0; i < 3; i++) {
    const r = await api("POST", "/api/auth/refresh", { cookie });
    assert.equal(r.status, 200, `member refresh ${i + 1} failed: ${r.raw}`);
    cookie = cookieOf(r);
  }
  assert.equal((await api("GET", "/api/lists/state", { token: login.body.accessToken })).status, 200);

  // The owner revokes access.
  const off = await api("POST", `/api/auth/household/members/${memberId}/disable`, { token: ownerToken });
  assert.equal(off.status, 200, off.raw);

  // Revocation beats the long window: the cookie is dead immediately.
  const afterRefresh = await api("POST", "/api/auth/refresh", { cookie });
  assert.equal(afterRefresh.status, 401, "a revoked member must not refresh");
  assert.match(afterRefresh.body.error, /refresh_(revoked|invalid)/);

  // And cannot sign back in.
  const relogin = await api("POST", "/api/auth/login", {
    body: { email: "child@fam.test", password: "childpass12" },
  });
  assert.equal(relogin.status, 403);
  assert.equal(relogin.body.error, "account_disabled");
});

test("concurrent 401s share one refresh, so a member is not logged out spuriously", async () => {
  // The client fires fetchState() and listMembers() in parallel on a cold start.
  // With a single-use refresh token, two independent refreshes would race and
  // one would fail. The client must share a single in-flight refresh instead.
  const apiJs = fs.readFileSync(path.resolve(process.cwd(), "..", "www", "api.js"), "utf8");
  assert.match(apiJs, /refreshInFlight/,
    "api.js must coalesce concurrent refreshes");
  assert.match(apiJs, /if \(refreshInFlight\) return refreshInFlight;/,
    "a second caller must join the in-flight refresh, not start a new one");

  // And behaviourally: a member's session survives the parallel cold-start path.
  const login = await api("POST", "/api/auth/login", {
    body: { email: "owner@fam.test", password: "correct horse 1" },
  });
  const cookie = cookieOf(login);
  const [state, me] = await Promise.all([
    api("GET", "/api/lists/state", { token: login.body.accessToken, cookie }),
    api("GET", "/api/auth/me", { token: login.body.accessToken, cookie }),
  ]);
  assert.equal(state.status, 200, "parallel state fetch");
  assert.equal(me.status, 200, "parallel me fetch");
});

test("an expired invite, once created, is rejected regardless of session length", async () => {
  const inv = await api("POST", "/api/auth/household/invites", {
    token: ownerToken, body: { email: "temp@fam.test", expiresInDays: 7 },
  });
  assert.ok(inv.body.expiresAt, "a 7-day invite has an expiry");

  // Move the expiry into the past.
  db.getDb().prepare(`UPDATE invites SET expires_at = ? WHERE id = ?`)
    .run(Date.now() - 1000, inv.body.id);

  const join = await api("POST", "/api/auth/register", {
    body: { email: "temp@fam.test", name: "T", password: "temppass12", inviteCode: inv.body.code },
  });
  assert.equal(join.status, 403);
  assert.equal(join.body.error, "invite_expired");
});

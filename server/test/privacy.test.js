/**
 * Family-privacy gate: the hardest requirement is "only people I personally
 * invited can get in". These tests attack that requirement directly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";

const SETUP_TOKEN = "family-setup-token-0123456789abcdef";

process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "privacy-test-secret-definitely-long-enough";
process.env.REQUIRE_INVITE = "true";     // permanently on
process.env.SETUP_TOKEN = SETUP_TOKEN;    // one-time claim
process.env.ALLOW_OPEN_SIGNUP = "false";
process.env.FAMILY_PIN = "";
process.env.ALLOW_WEAK_PASSWORDS = "false";
process.env.TRUST_PROXY = "false";
process.env.AUTH_RATE_LIMIT_MAX = "10000"; // isolate the gate from throttling
process.env.DATABASE_URL = ":memory:";
process.env.CORS_ORIGINS = "";

// Imported after the environment is set: config.js validates at module load.
const { makeTlsPems } = await import("./helpers/tls.js");
const { createApp } = await import("../src/index.js");
const pems = await makeTlsPems(["localhost", "127.0.0.1"]);

let server;
let base;
const pemsRef = pems;

test.before(async () => {
  const app = createApp();
  server = https.createServer({ key: pemsRef.key, cert: pemsRef.cert }, app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `https://localhost:${server.address().port}`;
});
test.after(() => server?.close());

function req(method, path, { body, token } = {}) {
  const url = new URL(base + path);
  // Accept either a pre-stringified body or a plain object.
  const payload =
    body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method,
      headers: {
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      ca: pems.cert, servername: "localhost",
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const reg = (over = {}) =>
  req("POST", "/api/auth/register", {
    body: JSON.stringify({ email: "x@y.test", name: "X", password: "password123", ...over }),
  });

/* ============================================================= the tests */

test("a stranger with no setup token cannot claim the household", async () => {
  const r = await reg({ email: "stranger@evil.test" });
  assert.equal(r.status, 403, r.raw);
  assert.equal(r.body.error, "setup_token_required");
});

test("a stranger with a wrong setup token is refused", async () => {
  for (const bad of ["wrong", "", "x".repeat(200), SETUP_TOKEN + "x", SETUP_TOKEN.slice(0, -1)]) {
    const r = await reg({ email: "stranger@evil.test", setupToken: bad });
    assert.equal(r.status, 403, `token "${bad.slice(0, 12)}" -> ${r.status} ${r.raw}`);
    assert.equal(r.body.error, "setup_token_required");
  }
});

test("the owner can claim the household with the correct setup token", async () => {
  const r = await reg({
    email: "owner@family.test", name: "Owner",
    password: "correct horse 1", setupToken: SETUP_TOKEN, householdName: "عائلتي",
  });
  assert.equal(r.status, 201, r.raw);
  assert.equal(r.body.user.role, "admin");
  ownerToken = r.body.accessToken;
});

let ownerToken;

test("after claiming, the setup token no longer grants anything", async () => {
  // Even the correct token must not create a second household.
  const r = await reg({ email: "latecomer@evil.test", setupToken: SETUP_TOKEN });
  assert.equal(r.status, 403, r.raw);
  assert.equal(r.body.error, "invite_required",
    "with a token set, later signups must need an invite, not a setup token");
});

test("no account can be created without an invite code, ever", async () => {
  for (const email of ["a@evil.test", "b@evil.test", "owner@family.test"]) {
    const r = await reg({ email });
    assert.equal(r.status, 403, `${email} -> ${r.status} ${r.raw}`);
    // Critically: a REGISTERED address must be indistinguishable from an
    // unknown one, or the endpoint becomes a household-member oracle.
    assert.equal(r.body.error, "invite_required", `${email} leaked that it exists`);
  }
});

test("the register endpoint cannot be used to enumerate household emails", async () => {
  // A known member and a total stranger must produce identical responses.
  const known = await reg({ email: "owner@family.test" });
  const unknown = await reg({ email: "definitely-not-a-member@evil.test" });
  assert.equal(known.status, unknown.status, "status differs -> enumeration possible");
  assert.equal(known.body.error, unknown.body.error, "error code differs -> enumeration possible");
  assert.equal(known.body.message, unknown.body.message, "message differs -> enumeration possible");
  assert.ok(!/registered|exist|taken/i.test(known.raw), "must not reveal that the account exists");
});

test("a made-up invite code is refused", async () => {
  for (const code of ["AAAA-BBBB-CCCC", "ZZZZ-ZZZZ-ZZZZ", "x", "K4M2-9XQP-7RTB"]) {
    const r = await reg({ email: "guess@evil.test", inviteCode: code });
    assert.equal(r.status, 403, code);
    assert.equal(r.body.error, "invite_invalid");
  }
});

test("an invited person can join, and only with the bound email", async () => {
  const inv = await req("POST", "/api/auth/household/invites", {
    token: ownerToken, body: { email: "child@family.test" },
  });
  assert.equal(inv.status, 201, inv.raw);
  const code = inv.body.code;

  // Wrong person cannot use it.
  const wrong = await reg({ email: "thief@evil.test", inviteCode: code });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error, "invite_email_mismatch");

  // The invited address can.
  const right = await reg({ email: "child@family.test", name: "Child", password: "childpass12", inviteCode: code });
  assert.equal(right.status, 201, right.raw);
  assert.equal(right.body.user.role, "member");
  assert.equal(right.body.user.householdId,
    (await req("GET", "/api/auth/me", { token: ownerToken })).body.user.householdId);
});

test("an unbound invite can be redeemed once and only once", async () => {
  const inv = await req("POST", "/api/auth/household/invites", { token: ownerToken, body: {} });
  const code = inv.body.code;

  const first = await reg({ email: "first@family.test", inviteCode: code });
  assert.equal(first.status, 201, first.raw);

  const second = await reg({ email: "second@family.test", inviteCode: code });
  assert.equal(second.status, 403);
  assert.equal(second.body.error, "invite_used");
});

test("a revoked invite stops working immediately", async () => {
  const inv = await req("POST", "/api/auth/household/invites", {
    token: ownerToken, body: { email: "revoked@family.test" },
  });
  const rev = await req("DELETE", "/api/auth/household/invites/" + inv.body.id, { token: ownerToken });
  assert.equal(rev.status, 200, rev.raw);

  const r = await reg({ email: "revoked@family.test", inviteCode: inv.body.code });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "invite_revoked");
});

test("an expired invite stops working", async () => {
  const inv = await req("POST", "/api/auth/household/invites", {
    token: ownerToken, body: { email: "expired@family.test", expiresInDays: 0 },
  });
  // expiresInDays:0 means "already expired" — never "no expiry".
  assert.notEqual(inv.body.expiresAt, null, "a 0-day invite must have an expiry, not be permanent");
  const r = await reg({ email: "expired@family.test", inviteCode: inv.body.code });
  assert.equal(r.status, 403, r.raw);
  assert.equal(r.body.error, "invite_expired");
});

test("an invite with no expiry set is genuinely permanent (not a silent 0)", async () => {
  const inv = await req("POST", "/api/auth/household/invites", {
    token: ownerToken, body: { email: "forever@family.test" },
  });
  assert.equal(inv.body.expiresAt, null, "omitting expiresInDays should mean no expiry");
  const r = await reg({ email: "forever@family.test", inviteCode: inv.body.code });
  assert.equal(r.status, 201, r.raw);
});

test("a member cannot mint invites, so the roster cannot grow on its own", async () => {
  const child = await req("POST", "/api/auth/login", {
    body: JSON.stringify({ email: "child@family.test", password: "childpass12" }),
  });
  const r = await req("POST", "/api/auth/household/invites", {
    token: child.body.accessToken, body: {},
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "admin_required");
});

test("a revoked member loses access immediately and cannot sign back in", async () => {
  const child = await req("POST", "/api/auth/login", {
    body: JSON.stringify({ email: "child@family.test", password: "childpass12" }),
  });
  const token = child.body.accessToken;
  assert.equal((await req("GET", "/api/lists/state", { token })).status, 200);

  const off = await req("POST", `/api/auth/household/members/${child.body.user.id}/disable`, { token: ownerToken });
  assert.equal(off.status, 200, off.raw);

  const after = await req("GET", "/api/lists/state", { token });
  assert.equal(after.status, 403);
  assert.equal(after.body.error, "account_disabled");

  const relogin = await req("POST", "/api/auth/login", {
    body: JSON.stringify({ email: "child@family.test", password: "childpass12" }),
  });
  assert.equal(relogin.status, 403);
});

test("an outsider with no account can read nothing", async () => {
  for (const path of ["/api/lists/state", "/api/auth/me", "/api/auth/household/members", "/api/auth/household/invites"]) {
    const r = await req("GET", path);
    assert.equal(r.status, 401, path);
    assert.ok(!/milk|حليب|family\.test/.test(r.raw), path + " leaked data");
  }
});

test("a disabled member's data is retained but their identity is scrubbed", async () => {
  const st = await req("GET", "/api/lists/state", { token: ownerToken });
  assert.equal(st.status, 200);
  // No disabled member should still be attributed as purchaser/requester.
  const disabled = (await req("GET", "/api/auth/household/members", { token: ownerToken }))
    .body.members.filter((m) => m.disabled);
  for (const m of disabled) {
    for (const list of [st.body.currentList, ...st.body.archived].filter(Boolean)) {
      for (const it of list.items) {
        assert.notEqual(it.purchasedBy, m.id, "disabled member still attributed as buyer");
      }
    }
  }
});

test("the owner cannot be locked out: last admin is protected", async () => {
  const me = await req("GET", "/api/auth/me", { token: ownerToken });
  const del = await req("DELETE", "/api/auth/account", { token: ownerToken });
  assert.equal(del.status, 400);
  assert.equal(del.body.error, "last_admin");

  const demote = await req("POST", `/api/auth/household/members/${me.body.user.id}/role`, {
    token: ownerToken, body: { role: "member" },
  });
  assert.equal(demote.status, 400);
  assert.equal(demote.body.error, "last_admin");
});

test("the bootstrap attempt is recorded in the audit log", async () => {
  const { getDb } = await import("../src/db.js");
  const rows = getDb().prepare(`SELECT action FROM audit_log ORDER BY id`).all().map((r) => r.action);
  assert.ok(rows.includes("auth.bootstrap.denied"), "denied bootstrap attempts must be audited");
  assert.ok(rows.includes("auth.register.bootstrap"), "successful claim must be audited");
  assert.ok(rows.includes("invite.revoked"));
});

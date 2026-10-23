/**
 * Web Push + server-side notification tests.
 *
 * Delivery to a real phone cannot be exercised here (it needs a browser-issued
 * subscription and the push service), but everything around it can: VAPID key
 * exposure, subscription storage/removal, household notifications on add/buy/
 * delete, and the same-origin static serving that makes push possible at all.
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-that-is-definitely-long-enough-32";
process.env.REQUIRE_INVITE = "true";
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
let session;

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, raw: text, headers: res.headers };
}

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  db.createHousehold({
    name: "بيت الاختبار",
    adminEmail: "push.owner@family.test",
    adminName: "أبو الاختبار",
    passwordHash: hashPassword("push-test-pass1"),
  });
  const login = await call("POST", "/api/auth/login", {
    body: { email: "push.owner@family.test", password: "push-test-pass1" },
  });
  assert.equal(login.status, 200, login.raw);
  session = login.body;
});

test.after(() => server?.close());

const auth = () => ({ token: session.accessToken });

test("push key requires a session and returns a usable VAPID key", async () => {
  const anonymous = await call("GET", "/api/push/key");
  assert.equal(anonymous.status, 401);

  const res = await call("GET", "/api/push/key", auth());
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.enabled, true);
  assert.equal(typeof res.body.publicKey, "string");
  assert.ok(res.body.publicKey.length >= 60, "VAPID public key looks too short");
});

test("a subscription can be registered, counted, and removed", async () => {
  const subscription = {
    endpoint: "https://127.0.0.1:9/push/device-one",
    expirationTime: null,
    keys: { p256dh: "B".repeat(65), auth: "A".repeat(22) },
  };

  const added = await call("POST", "/api/push/subscribe", { ...auth(), body: subscription });
  assert.equal(added.status, 201, added.raw);
  assert.equal(added.body.subscriptions, 1);

  // Re-registering the same endpoint updates it instead of duplicating it.
  const again = await call("POST", "/api/push/subscribe", { ...auth(), body: subscription });
  assert.equal(again.status, 201, again.raw);
  assert.equal(again.body.subscriptions, 1);

  const tested = await call("POST", "/api/push/test", { ...auth(), body: {} });
  assert.equal(tested.status, 200, tested.raw);
  assert.equal(tested.body.subscriptions, 1);
  assert.equal(tested.body.sent, 0); // NODE_ENV=test skips the real round trip

  const removed = await call("POST", "/api/push/unsubscribe", {
    ...auth(),
    body: { endpoint: subscription.endpoint },
  });
  assert.equal(removed.status, 200, removed.raw);
  assert.equal(removed.body.removed, true);

  const after = await call("POST", "/api/push/test", { ...auth(), body: {} });
  assert.equal(after.body.subscriptions, 0);
});

test("malformed subscriptions are rejected", async () => {
  const bad = await call("POST", "/api/push/subscribe", {
    ...auth(),
    body: { endpoint: "not-a-url", keys: { p256dh: "x", auth: "y" } },
  });
  assert.equal(bad.status, 400, bad.raw);
  assert.equal(bad.body.error, "validation_failed");
});

test("adding, buying and deleting an item creates household notifications", async () => {
  const list = await call("POST", "/api/lists/bootstrap", {
    ...auth(),
    body: { week: 1, budget: 500 },
  });
  assert.equal(list.status, 201, list.raw);

  const item = await call("POST", `/api/lists/${list.body.id}/items`, {
    ...auth(),
    body: { name: "حليب", qty: 2, unit: "عبوة", price: 15, store: "العثيم", category: "dairy" },
  });
  assert.equal(item.status, 201, item.raw);

  let state = await call("GET", "/api/lists/state", auth());
  assert.equal(state.status, 200, state.raw);
  const added = state.body.notifications[0];
  assert.equal(added.type, "add");
  assert.match(added.text, /حليب/);

  const bought = await call("PATCH", `/api/items/${item.body.id}`, {
    ...auth(),
    body: { purchased: true },
  });
  assert.equal(bought.status, 200, bought.raw);

  state = await call("GET", "/api/lists/state", auth());
  assert.equal(state.body.notifications[0].type, "buy");
  assert.match(state.body.notifications[0].text, /حليب/);

  const deleted = await call("DELETE", `/api/items/${item.body.id}`, auth());
  assert.equal(deleted.status, 200, deleted.raw);

  state = await call("GET", "/api/lists/state", auth());
  assert.equal(state.body.notifications[0].type, "del");
  assert.match(state.body.notifications[0].text, /حليب/);
});

test("the same origin serves the PWA with a CSP that allows its assets", async () => {
  const app = await call("GET", "/");
  assert.equal(app.status, 200);
  assert.match(app.headers.get("content-type") || "", /text\/html/);
  assert.match(app.raw, /مقاضي العائلة/);
  assert.match(app.raw, /fg-config\.js/);

  const csp = app.headers.get("content-security-policy") || "";
  assert.match(csp, /cdn\.jsdelivr\.net/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);

  const config = await call("GET", "/fg-config.js");
  assert.equal(config.status, 200);
  assert.match(config.raw, /window\.FG_API_BASE/);
  assert.equal(config.headers.get("cache-control"), "no-store");

  const sw = await call("GET", "/sw.js");
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get("cache-control") || "", /no-cache/);
  assert.match(sw.raw, /addEventListener\("push"/);

  const missingApi = await call("GET", "/api/nope", auth());
  assert.equal(missingApi.status, 404);
  assert.equal(missingApi.body.error, "not_found");
});

/**
 * Runs the REAL server in-process and exercises the REAL www/api.js client
 * against it inside JSDOM. This is the integration seam: if the client's
 * request shapes, token handling or sync calls disagree with the server, this
 * fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-that-is-definitely-long-enough-32";
process.env.REQUIRE_INVITE = "false";
process.env.AUTH_RATE_LIMIT_MAX = "1000";

const { createApp } = await import("../src/index.js");

let server;
let base;
let ownerToken;

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;

  // The very first signup bootstraps the household; every later one needs an invite.
  const r = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@fam.test", name: "Owner", password: "correct horse 1" }),
  });
  const d = await r.json();
  assert.equal(r.status, 201, JSON.stringify(d));
  ownerToken = d.accessToken;

  // Give the household an initial list so members have something to share.
  const l = await fetch(`${base}/api/lists`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name: "الأسبوع 1", week: 1, budget: 600 }),
  });
  assert.equal(l.status, 201, await l.text());
});
test.after(() => server?.close());

const apiSource = fs.readFileSync(
  path.resolve(process.cwd(), "..", "www", "api.js"), "utf8");

/**
 * Boots a JSDOM window with api.js loaded, talking to the live server.
 *
 * Node's global fetch keeps no cookie jar, so `credentials: 'include'` would be
 * silently useless and the refresh flow untestable. This wrapper adds a minimal
 * jar, making the client behave as it does in a real browser/WebView.
 */
function makeClient() {
  const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
    url: "https://app.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const jar = new Map(); // name -> value

  w.fetch = (input, init) => {
    const opts = Object.assign({}, init);
    const headers = Object.assign({}, opts.headers);
    if (jar.size) {
      headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    opts.headers = headers;
    return fetch(String(input), opts).then((res) => {
      for (const sc of res.headers.getSetCookie?.() ?? []) {
        const [pair] = sc.split(";");
        const idx = pair.indexOf("=");
        if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
      return res;
    });
  };

  w.localStorage.clear();
  w.eval(apiSource);
  w.FG_API.setConfig(base);
  w.__jar = jar;
  return w;
}

const PASSWORD = "memberpass1";

/** Mints an invite server-side, then registers through the real client. */
async function signUpViaClient(email) {
  const inv = await fetch(`${base}/api/auth/household/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ email, role: "member" }),
  });
  const code = (await inv.json()).code;
  const w = makeClient();
  const user = await w.FG_API.signUp({ email, name: email.split("@")[0], password: PASSWORD, inviteCode: code });
  return { w, user };
}

async function signInViaClient(email, password) {
  const w = makeClient();
  const user = await w.FG_API.signIn(email, password || PASSWORD);
  return { w, user };
}

/* ================================================================== tests */

test("api.js loads and exposes the expected surface", () => {
  const w = makeClient();
  const api = w.FG_API;
  assert.ok(api, "FG_API must be defined");
  for (const fn of ["ready", "signIn", "signUp", "signOut", "deleteAccount",
                    "fetchState", "addItem", "updateItem", "deleteItem",
                    "createList", "finishList", "push", "drain"]) {
    assert.equal(typeof api[fn], "function", `missing ${fn}()`);
  }
  w.close();
});

test("ready() reports unconfigured when no API base is set", async () => {
  const w = makeClient();
  w.FG_API.setConfig("");
  const r = await w.FG_API.ready();
  assert.equal(r.signedIn, false);
  assert.equal(r.configured, false);
  w.close();
});

test("invited member signs up, works with the shared list, and signs out", async () => {
  const { w, user } = await signUpViaClient("journey@fam.test");
  const api = w.FG_API;
  assert.equal(user.role, "member");
  assert.equal(api.isSignedIn(), true);

  // The owner's list is visible to the member.
  const st = await api.fetchState();
  assert.ok(st.currentList, "household must already have an active list");

  const list = await api.createList("Journey list", 99, 250).catch((e) => e);
  let targetList = st.currentList;
  if (list && list.id) targetList = list;

  // Add an item through the client.
  const item = await api.addItem(targetList.id, {
    name: "حليب", qty: 2, unit: "عبوة", price: 15, store: "العثيم", category: "dairy",
  });
  assert.equal(item.name, "حليب");
  assert.equal(item.purchased, false);

  // Mark purchased; actual price defaults to expected and the buyer is recorded.
  const bought = await api.updateItem(item.id, { purchased: true });
  assert.equal(bought.purchased, true);
  assert.equal(bought.actualPrice, 15);
  assert.equal(bought.purchasedBy, user.id);

  // Un-purchasing clears the spend, matching the UI's behaviour.
  const undone = await api.updateItem(item.id, { purchased: false });
  assert.equal(undone.purchased, false);
  assert.equal(undone.actualPrice, null);
  assert.equal(undone.purchasedBy, null);

  // Edit and delete.
  const edited = await api.updateItem(item.id, { name: "حليب كامل", price: 18 });
  assert.equal(edited.name, "حليب كامل");
  await api.deleteItem(item.id);

  await api.signOut();
  assert.equal(api.isSignedIn(), false);
  w.close();
});

test("a member cannot perform admin-only actions", async () => {
  const { w } = await signUpViaClient("notadmin@fam.test");
  await assert.rejects(() => w.FG_API.inviteMember({}), (e) => e.status === 403);
  await assert.rejects(() => w.FG_API.listInvites(), (e) => e.status === 403);
  // Reading the roster is allowed.
  const roster = await w.FG_API.listMembers();
  assert.ok(Array.isArray(roster.members));
  w.close();
});

test("registration without a valid invite is refused", async () => {
  const w = makeClient();
  await assert.rejects(
    () => w.FG_API.signUp({ email: "nope@fam.test", name: "N", password: PASSWORD }),
    (e) => e.status === 403 && e.code === "invite_required",
  );
  w.close();
});

test("a consumed invite code cannot be reused", async () => {
  const inv = await fetch(`${base}/api/auth/household/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ email: "once@fam.test" }),
  });
  const code = (await inv.json()).code;

  const first = makeClient();
  await first.FG_API.signUp({ email: "once@fam.test", name: "Once", password: PASSWORD, inviteCode: code });
  first.close();

  const second = makeClient();
  await assert.rejects(
    () => second.FG_API.signUp({ email: "other@fam.test", name: "Other", password: PASSWORD, inviteCode: code }),
    (e) => e.status === 403 && e.code === "invite_used",
  );
  second.close();
});

test("one household cannot see or modify another household's data", async () => {
  const { w: a } = await signUpViaClient("iso-a@fam.test");
  const beforeAdd = await a.FG_API.fetchState();
  const added = await a.FG_API.addItem(beforeAdd.currentList.id, { name: "SECRET-ITEM", price: 42 });
  assert.equal(added.name, "SECRET-ITEM");
  // Re-fetch: the previous snapshot predates the add.
  const stA = await a.FG_API.fetchState();

  // Build a genuinely separate second household and sign a real client into it.
  const db = await import("../src/db.js");
  const { hashPassword, makeInviteCode } = await import("../src/crypto.js");
  const other = db.createHousehold({
    name: "Other family", adminEmail: "other-owner@fam.test",
    adminName: "Other", passwordHash: hashPassword("other owner 1"),
  });
  const otherCode = makeInviteCode();
  db.createInvite({ householdId: other.householdId, code: otherCode, email: "outsider@fam.test", role: "member" });

  const b = makeClient();
  const outsider = await b.FG_API.signUp({
    email: "outsider@fam.test", name: "Outsider", password: PASSWORD, inviteCode: otherCode,
  });
  assert.notEqual(outsider.householdId, stA.householdId, "must be a different household");

  // The outsider's state must not contain the first household's data.
  const stB = await b.FG_API.fetchState();
  assert.ok(!JSON.stringify(stB).includes("SECRET-ITEM"), "no cross-household leakage in state");
  assert.ok(!stB.currentList || !stB.currentList.items.some((i) => i.name === "SECRET-ITEM"));

  // Reaching the first household's item by id must fail.
  const secretId = stA.currentList.items.find((i) => i.name === "SECRET-ITEM").id;
  await assert.rejects(
    () => b.FG_API.updateItem(secretId, { name: "stolen" }),
    (e) => e.status === 404,
    "cross-household item write must 404",
  );
  await assert.rejects(
    () => b.FG_API.deleteItem(secretId),
    (e) => e.status === 404,
    "cross-household item delete must 404",
  );

  // A client-supplied householdId in the body must be ignored entirely.
  const hijack = await fetch(`${base}/api/lists`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name: "Injected", week: 900, householdId: other.householdId }),
  });
  const created = await hijack.json();
  // Either rejected for the existing active list, or created inside the caller's
  // own household — never inside the household named in the body.
  if (hijack.status === 201) {
    const check = db.getDb().prepare(`SELECT household_id FROM lists WHERE id = ?`).get(created.id);
    assert.equal(check.household_id, stA.householdId,
      "a body-supplied householdId must never be honoured");
  } else {
    assert.equal(hijack.status, 400);
  }

  a.close(); b.close();
});

test("invalid access token triggers a silent refresh and replay", async () => {
  const { w } = await signUpViaClient("refresh@fam.test");

  // Corrupt only the first /api/lists/state call; the client must recover.
  const orig = w.fetch;
  let firstCall = true;
  w.fetch = function (input, init) {
    if (firstCall && String(input).indexOf("/api/lists/state") !== -1) {
      firstCall = false;
      const headers = Object.assign({}, init.headers, { authorization: "Bearer garbage.token.value" });
      init = Object.assign({}, init, { headers });
    }
    return orig(input, init);
  };
  const st = await w.FG_API.fetchState();
  assert.ok(st && st.householdId, "client must recover from a bad access token");
  w.fetch = orig;
  w.close();
});

test("sign-in with wrong credentials surfaces a usable error", async () => {
  await signUpViaClient("wrongpw@fam.test");
  const w = makeClient();
  await assert.rejects(
    () => w.FG_API.signIn("wrongpw@fam.test", "not the password 1"),
    (e) => e.status === 401 && /incorrect/i.test(e.message),
  );
  w.close();
});

test("change password works and the old one stops working", async () => {
  const { w } = await signUpViaClient("changer@fam.test");
  const NEW = "a brand new pass 7";
  await w.FG_API.changePassword(PASSWORD, NEW);
  w.close();

  await assert.rejects(() => signInViaClient("changer@fam.test", PASSWORD), (e) => e.status === 401);
  const ok = await signInViaClient("changer@fam.test", NEW);
  assert.ok(ok.user.id);
  ok.w.close();
});

test("account deletion works from the client and revokes access (App Review 5.1.1(v))", async () => {
  const { w } = await signUpViaClient("goner@fam.test");
  await w.FG_API.deleteAccount();
  assert.equal(w.FG_API.isSignedIn(), false);
  await assert.rejects(() => w.FG_API.fetchState(), (e) => e.status === 401);
  await assert.rejects(() => signInViaClient("goner@fam.test"), (e) => e.status === 401);
  w.close();
});

test("the client queues a mutation while offline and drains it on reconnect", async () => {
  const { w } = await signUpViaClient("offline@fam.test");
  const api = w.FG_API;
  const st = await api.fetchState();

  const realFetch = w.fetch;
  Object.defineProperty(w.navigator, "onLine", { value: false, configurable: true });
  w.fetch = () => Promise.reject(new TypeError("Failed to fetch"));

  // push() is the queueing entry point used by the app's commit().
  const job = {
    method: "POST",
    path: `/api/lists/${st.currentList.id}/items`,
    body: { name: "OFFLINE-ITEM", qty: 1, price: 5 },
  };
  await api.push(job);
  assert.equal(api.pendingCount(), 1, "offline work must be queued, not lost");

  // Reconnect and drain.
  w.fetch = realFetch;
  Object.defineProperty(w.navigator, "onLine", { value: true, configurable: true });
  await api.drain();

  assert.equal(api.pendingCount(), 0, "queue must be empty after a successful drain");
  const after = await api.fetchState();
  const names = after.currentList.items.map((i) => i.name);
  assert.ok(names.includes("OFFLINE-ITEM"), "the queued item must reach the server");
  w.close();
});

test("a mutation that the server rejects is dropped, not retried forever", async () => {
  const { w } = await signUpViaClient("badjob@fam.test");
  const api = w.FG_API;
  const st = await api.fetchState();

  // Invalid category -> 400. Retrying can never succeed, so it must be discarded.
  await api.push({
    method: "POST",
    path: `/api/lists/${st.currentList.id}/items`,
    body: { name: "BAD", category: "not-a-real-category" },
  });
  assert.equal(api.pendingCount(), 0, "a 4xx must not be queued for retry");
  w.close();
});

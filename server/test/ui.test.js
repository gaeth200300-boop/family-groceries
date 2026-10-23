/**
 * End-to-end: drives the REAL www/index.html UI in JSDOM against the REAL
 * server. Proves the auth screen, invite flow, and shared-data sync work
 * through the actual markup and click handlers, not just the API client.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";
process.env.JWT_SECRET = "test-secret-that-is-definitely-long-enough-32";
process.env.REQUIRE_INVITE = "false";
process.env.AUTH_RATE_LIMIT_MAX = "1000";
// A local .env may define SETUP_TOKEN; pin the value for this test process so
// the UI setup test is deterministic in both CI and a developer machine.
process.env.SETUP_TOKEN = "test-setup-token-0123456789";

const { createApp } = await import("../src/index.js");

let server, base;

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server?.close());

const HTML = fs.readFileSync(path.resolve(process.cwd(), "..", "www", "index.html"), "utf8");
// JSDOM does not fetch external <script src> unless resources:"usable", and a
// relative src will not resolve from https://app.test/. Injecting api.js
// directly is both simpler and deterministic.
const API_JS = fs.readFileSync(path.resolve(process.cwd(), "..", "www", "api.js"), "utf8");

/** Loads the whole app page in JSDOM, pointed at the live server. */
function openApp({ clearStorage = true, apiBase = base } = {}) {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on("jsdomError", (e) => errs.push(String(e.message)));
  const dom = new JSDOM(HTML, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://app.test/",
    virtualConsole: vc,
    beforeParse(w) {
      w.FG_API_BASE = apiBase;
      w.lucide = { createIcons() {} };
      w.Chart = function () { this.destroy = () => {}; };
      w.Chart.defaults = { font: {} };
      if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
      w.scrollTo = () => {};
      w.confirm = () => true;
      w.prompt = () => "Local User";
      w.__errs = [];
      w.addEventListener("error", (e) => w.__errs.push(String(e.error || e.message)));

      // cookie jar so the refresh token survives like it would in a WebView
      const jar = new Map();
      w.fetch = (input, init) => {
        const opts = Object.assign({}, init);
        const headers = Object.assign({}, opts.headers);
        if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
        opts.headers = headers;
        return fetch(String(input), opts).then((res) => {
          for (const sc of res.headers.getSetCookie?.() ?? []) {
            const [pair] = sc.split(";");
            const i = pair.indexOf("=");
            if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
          }
          return res;
        });
      };
      w.__jar = jar;

      // Must run before the page's own inline scripts.
      w.eval(API_JS);
    },
  });
  if (clearStorage) dom.window.localStorage.clear();
  return { w: dom.window, d: dom.window.document, errs };
}

const tick = (w, ms = 60) => new Promise((r) => setTimeout(r, ms));
const click = (w, el) => {
  assert.ok(el, "click target missing");
  el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
};
const submit = (w, el) => {
  assert.ok(el, "form missing");
  el.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
};

/* ==================================================================== tests */

test("app boots to the sign-in screen when a server is configured", async () => {
  const { w, d } = openApp();
  await tick(w, 300);
  assert.equal(d.querySelector("#auth").hidden, false, "auth screen must be visible");
  assert.equal(d.querySelector("#app").hidden, true, "app must be hidden");
  assert.equal(d.querySelector("#paneSignin").hidden, false, "sign-in pane active");
  assert.ok(d.querySelector("#signinForm"), "sign-in form present");
  assert.ok(!/1234/.test(d.querySelector("#auth").textContent), "demo PIN must not be shown");
  assert.equal(w.__errs.length, 0, w.__errs.join(" | "));
  w.close();
});

test("first-run setup creates the household owner and enters the app", async () => {
  const { w, d } = openApp();
  await tick(w, 250);
  // Drive setup explicitly (the first-run slot is only open while the DB is empty).
  d.querySelector("#suName").value = "Owner";
  d.querySelector("#suEmail").value = "ui-owner@fam.test";
  d.querySelector("#suPass").value = "correct horse 1";
  d.querySelector("#suHouse").value = "عائلتي";
  d.querySelector("#suToken").value = "test-setup-token-0123456789";
  submit(w, d.querySelector("#setupForm"));
  await tick(w, 500);

  assert.equal(d.querySelector("#app").hidden, false, "should be inside the app now: " + d.querySelector("#setupError").textContent);
  assert.equal(d.querySelector("#auth").hidden, true);
  assert.equal(w.__errs.length, 0, w.__errs.join(" | "));
  w.close();
});

test("wrong password shows an inline error and does not enter the app", async () => {
  const { w, d } = openApp();
  await tick(w, 250);
  d.querySelector("#siEmail").value = "ui-owner@fam.test";
  d.querySelector("#siPass").value = "definitely wrong 1";
  submit(w, d.querySelector("#signinForm"));
  await tick(w, 400);
  assert.equal(d.querySelector("#app").hidden, true, "must stay locked out");
  assert.equal(d.querySelector("#authError").hidden, false, "error must be visible");
  assert.ok(d.querySelector("#authError").textContent.length > 0);
  w.close();
});

test("signs in with the correct password and renders the shared dashboard", async () => {
  const { w, d } = openApp();
  await tick(w, 250);
  d.querySelector("#siEmail").value = "ui-owner@fam.test";
  d.querySelector("#siPass").value = "correct horse 1";
  submit(w, d.querySelector("#signinForm"));
  await tick(w, 600);

  assert.equal(d.querySelector("#app").hidden, false, "signed-in");
  const dash = d.querySelector("#view-dashboard");
  assert.ok(dash.innerHTML.length > 300, "dashboard rendered: " + dash.innerHTML.length + " chars");
  assert.equal(w.__errs.length, 0, w.__errs.join(" | "));
  w.close();
});

test("all seven views render in server mode", async () => {
  const { w, d } = openApp();
  await tick(w, 250);
  d.querySelector("#siEmail").value = "ui-owner@fam.test";
  d.querySelector("#siPass").value = "correct horse 1";
  submit(w, d.querySelector("#signinForm"));
  await tick(w, 600);

  for (const v of ["list", "shopping", "history", "frequent", "stats", "family", "dashboard"]) {
    const before = w.__errs.length;
    const btn = d.querySelector(`.bn-item[data-view="${v}"]`) || d.querySelector(`[data-action="nav"][data-view="${v}"]`);
    click(w, btn);
    await tick(w, 80);
    const sec = d.querySelector("#view-" + v);
    assert.ok(sec.classList.contains("active"), `${v} should be active`);
    assert.ok(sec.innerHTML.length > 40, `${v} rendered only ${sec.innerHTML.length} chars`);
    assert.equal(w.__errs.length, before, `${v} raised errors: ${w.__errs.slice(before).join("|")}`);
  }
  w.close();
});

test("adding an item in the UI persists it to the server", async () => {
  const { w, d } = openApp();
  await tick(w, 250);
  d.querySelector("#siEmail").value = "ui-owner@fam.test";
  d.querySelector("#siPass").value = "correct horse 1";
  submit(w, d.querySelector("#signinForm"));
  await tick(w, 600);

  // Capture the token the app is using, then verify server-side.
  let token = null;
  const orig = w.fetch;
  w.fetch = (i, init) => {
    if (init?.headers?.authorization) token = init.headers.authorization.replace("Bearer ", "");
    return orig(i, init);
  };

  click(w, d.querySelector('[data-action="open-add"]'));
  await tick(w, 80);
  assert.ok(d.querySelector("#itemForm"), "item form opened");
  d.querySelector("#fName").value = "منتج من الواجهة";
  d.querySelector("#fPrice").value = "33";
  submit(w, d.querySelector("#itemForm"));
  await tick(w, 300);
  w.fetch = orig;

  // Ask the server directly.
  const res = await fetch(`${base}/api/lists/state`, { headers: { authorization: `Bearer ${token}` } });
  const state = await res.json();
  const names = state.currentList.items.map((i) => i.name);
  assert.ok(names.includes("منتج من الواجهة"), "server has the item, got: " + JSON.stringify(names));
  assert.equal(w.__errs.length, 0, w.__errs.join(" | "));
  w.close();
});

test("an invite created in the UI lets a second person join and see the same list", async () => {
  // Owner device
  const owner = openApp();
  await tick(owner.w, 250);
  owner.d.querySelector("#siEmail").value = "ui-owner@fam.test";
  owner.d.querySelector("#siPass").value = "correct horse 1";
  submit(owner.w, owner.d.querySelector("#signinForm"));
  await tick(owner.w, 600);

  // Go to the family view and create an invite
  click(owner.w, owner.d.querySelector('[data-action="nav"][data-view="family"]'));
  await tick(owner.w, 100);
  const addBtn = owner.d.querySelector('[data-action="open-add-member"]');
  assert.ok(addBtn, "admin sees the invite button");
  click(owner.w, addBtn);
  await tick(owner.w, 100);
  owner.d.querySelector("#mfEmail").value = "ui-member@fam.test";
  submit(owner.w, owner.d.querySelector("#memberForm"));
  await tick(owner.w, 500);

  const codeEl = owner.d.querySelector("#inviteCodeText");
  assert.ok(codeEl, "invite code modal shown");
  const code = codeEl.textContent.trim();
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, "code format: " + code);
  click(owner.w, owner.d.querySelector('[data-action="close-modal"]'));
  await tick(owner.w, 80);

  // Second device joins with the code
  const member = openApp();
  await tick(member.w, 250);
  click(member.w, member.d.querySelector('[data-auth-tab="join"]'));
  await tick(member.w, 60);
  member.d.querySelector("#jnName").value = "Member";
  member.d.querySelector("#jnEmail").value = "ui-member@fam.test";
  member.d.querySelector("#jnPass").value = "memberpass1";
  member.d.querySelector("#jnCode").value = code;
  submit(member.w, member.d.querySelector("#joinForm"));
  await tick(member.w, 700);

  assert.equal(member.d.querySelector("#app").hidden, false,
    "member signed in; join error = " + member.d.querySelector("#joinError").textContent);
  const memberDash = member.d.querySelector("#view-dashboard");
  assert.ok(memberDash.innerHTML.length > 300, "member sees the dashboard");
  // Shared data: the member sees the item the owner added.
  assert.ok(/منتج من الواجهة/.test(memberDash.textContent),
    "member must see the owner's item (shared list works)");

  owner.w.close(); member.w.close();
});

test("joining without a valid invite is refused with a readable message", async () => {
  const { w, d } = openApp();
  await tick(w, 250);
  click(w, d.querySelector('[data-auth-tab="join"]'));
  await tick(w, 60);
  d.querySelector("#jnName").value = "Outsider";
  d.querySelector("#jnEmail").value = "ui-outsider@fam.test";
  d.querySelector("#jnPass").value = "outsiderpass1";
  d.querySelector("#jnCode").value = "AAAA-BBBB-CCCC";
  submit(w, d.querySelector("#joinForm"));
  await tick(w, 500);
  assert.equal(d.querySelector("#app").hidden, true, "must stay locked out");
  assert.equal(d.querySelector("#joinError").hidden, false, "error shown");
  w.close();
});

test("account settings exposes delete-account and the account modal opens", async () => {
  const { w, d } = openApp();
  await tick(w, 250);
  d.querySelector("#siEmail").value = "ui-owner@fam.test";
  d.querySelector("#siPass").value = "correct horse 1";
  submit(w, d.querySelector("#signinForm"));
  await tick(w, 600);

  click(w, d.querySelector('[data-action="open-account"]'));
  await tick(w, 100);
  assert.ok(d.querySelector('[data-action="delete-account"]'),
    "App Review 5.1.1(v) requires an in-app delete control");
  assert.ok(d.querySelector('[data-action="change-password"]'), "change password offered");
  assert.ok(/متصل بالخادم/.test(d.querySelector("#modalRoot").textContent),
    "modal should report it is in server mode");
  w.close();
});

test("logging out returns to the auth screen", async () => {
  const { w, d } = openApp();
  await tick(w, 250);
  d.querySelector("#siEmail").value = "ui-owner@fam.test";
  d.querySelector("#siPass").value = "correct horse 1";
  submit(w, d.querySelector("#signinForm"));
  await tick(w, 600);
  assert.equal(d.querySelector("#app").hidden, false);

  click(w, d.querySelector('[data-action="logout"]'));
  await tick(w, 400);
  assert.equal(d.querySelector("#app").hidden, true);
  assert.equal(d.querySelector("#auth").hidden, false);
  w.close();
});

test("with no server configured the app falls back to local mode", async () => {
  const { w, d } = openApp({ apiBase: "" });
  await tick(w, 300);

  assert.equal(d.querySelector("#paneLocal").hidden, false, "local pane must be shown");
  assert.equal(d.querySelector("#auth").hidden, false);
  const pickers = d.querySelectorAll("#localPicker .pick-member");
  assert.equal(pickers.length, 4, "seeded profiles offered, got " + pickers.length);

  // Enter as a local profile
  pickers[0].dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick(w, 200);
  assert.equal(d.querySelector("#app").hidden, false, "local sign-in should work");
  assert.ok(d.querySelector("#view-dashboard").innerHTML.length > 300, "local dashboard renders");
  assert.equal(w.__errs.length, 0, w.__errs.join(" | "));
  w.close();
});

/**
 * Family-privacy UI: the owner must be able to see outstanding invites and
 * revoke them, and the app must never display or accept a PIN.
 * Runs the real index.html against the real server, with SETUP_TOKEN enabled.
 */
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

const SETUP_TOKEN = "ui-setup-token-0123456789abcdef";

process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "invite-ui-test-secret-long-enough-32";
process.env.REQUIRE_INVITE = "true";
process.env.SETUP_TOKEN = SETUP_TOKEN;
process.env.TRUST_PROXY = "false";
process.env.AUTH_RATE_LIMIT_MAX = "10000";
process.env.DATABASE_URL = ":memory:";
process.env.CORS_ORIGINS = "";

const { makeTlsPems } = await import("./helpers/tls.js");
const { createApp } = await import("../src/index.js");

const pems = await makeTlsPems(["localhost", "127.0.0.1"]);
let server, base;

test.before(async () => {
  const app = createApp();
  server = https.createServer({ key: pems.key, cert: pems.cert }, app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `https://localhost:${server.address().port}`;
});
test.after(() => server?.close());

const HTML = fs.readFileSync(path.resolve(process.cwd(), "..", "www", "index.html"), "utf8");
const API_JS = fs.readFileSync(path.resolve(process.cwd(), "..", "www", "api.js"), "utf8");

function openApp({ seedCookies = null, url = "https://app.test/" } = {}) {
  const vc = new VirtualConsole();
  const dom = new JSDOM(HTML, {
    runScripts: "dangerously", pretendToBeVisual: true,
    url, virtualConsole: vc,
    beforeParse(w) {
      w.FG_API_BASE = base;
      w.lucide = { createIcons() {} };
      w.Chart = function () { this.destroy = () => {}; };
      w.Chart.defaults = { font: {} };
      if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
      w.scrollTo = () => {};
      w.__errs = [];
      w.addEventListener("error", (e) => w.__errs.push(String(e.error || e.message)));

      // Stands in for the WebView's persistent cookie jar, which survives an
      // app restart. A fresh JSDOM normally starts empty, so tests that model a
      // restart pass the previous jar back in via seedCookies.
      const jar = new Map(seedCookies || []);
      w.__jar = jar;
      w.fetch = (input, init = {}) => {
        const url = new URL(String(input));
        const headers = Object.assign({}, init.headers);
        if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
        const payload = init.body ? (typeof init.body === "string" ? init.body : JSON.stringify(init.body)) : null;
        return new Promise((resolve, reject) => {
          const r = https.request({
            hostname: url.hostname, port: url.port,
            path: url.pathname + url.search, method: init.method || "GET",
            headers: {
              ...headers,
              ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
            },
            ca: pems.cert, servername: "localhost",
          }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => {
              for (const sc of res.headers["set-cookie"] || []) {
                const [pair] = sc.split(";");
                const i = pair.indexOf("=");
                if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
              }
              resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                text: async () => data,
                json: async () => JSON.parse(data || "null"),
                headers: { get: (k) => res.headers[String(k).toLowerCase()] ?? null },
              });
            });
          });
          r.on("error", reject);
          if (payload) r.write(payload);
          r.end();
        });
      };
      w.eval(API_JS);
    },
  });
  dom.window.localStorage.clear();
  return { w: dom.window, d: dom.window.document };
}

const tick = (w, ms = 150) => new Promise((r) => setTimeout(r, ms));
const click = (w, el) => {
  assert.ok(el, "click target missing");
  el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
};
const submit = (w, el) => {
  assert.ok(el, "form missing");
  el.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
};

/** Node-side request to the self-signed HTTPS server (global fetch cannot). */
function api(method, p, { body, token } = {}) {
  const url = new URL(base + p);
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method,
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

/* Claim the household once, before the UI tests run. */
let claimed = false;
async function ensureOwner() {
  if (claimed) return;
  const r = await api("POST", "/api/auth/register", {
    body: { email: "owner@family.test", name: "Owner", password: "correct horse 1", setupToken: SETUP_TOKEN },
  });
  assert.equal(r.status, 201, r.raw);
  claimed = true;
}

async function signInOwner() {
  const { w, d } = openApp();
  await tick(w, 300);
  d.querySelector("#siEmail").value = "owner@family.test";
  d.querySelector("#siPass").value = "correct horse 1";
  submit(w, d.querySelector("#signinForm"));
  await tick(w, 700);
  assert.equal(d.querySelector("#app").hidden, false,
    "owner signed in; error = " + (d.querySelector("#authError")?.textContent || ""));
  return { w, d };
}

/** Signs the owner in over the API and caches their access token. */
let _ownerToken = null;
async function ownerToken() {
  if (!_ownerToken) {
    const r = await api("POST", "/api/auth/login", {
      body: { email: "owner@family.test", password: "correct horse 1" },
    });
    assert.equal(r.status, 200, r.raw);
    _ownerToken = r.body.accessToken;
  }
  return _ownerToken;
}

/* ==================================================================== tests */

test("the household is claimed with a setup token, not an open signup", async () => {
  await ensureOwner();
  // A second open signup must fail.
  const r = await api("POST", "/api/auth/register", { body: { email: "sneaky@evil.test", name: "S", password: "password123" } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "invite_required");
});

test("the app never displays a PIN anywhere", async () => {
  const { w, d } = await signInOwner();
  const visible = d.querySelector("#auth").textContent + d.querySelector("#app").textContent;
  assert.ok(!/1234/.test(visible), "a PIN must never be shown to the user");
  // And there is no PIN field in the DOM at all.
  assert.equal(d.querySelectorAll("#pinInput").length, 0);
  assert.equal(d.querySelectorAll("#memberPicker").length, 0);
  w.close();
});

test("the family view offers invite management to the admin", async () => {
  const { w, d } = await signInOwner();
  click(w, d.querySelector('[data-action="nav"][data-view="family"]'));
  await tick(w, 150);
  assert.ok(d.querySelector('[data-action="open-invites"]'), "invites button present for admin");
  assert.ok(d.querySelector('[data-action="open-add-member"]'), "invite-member button present");
  // exactly one of each, not duplicated in the header and footer
  assert.equal(d.querySelectorAll('[data-action="open-add-member"]').length, 1);
  assert.equal(d.querySelectorAll('[data-action="open-invites"]').length, 1);
  w.close();
});

test("an invite can be created with an expiry, and the code is shown once", async () => {
  const { w, d } = await signInOwner();
  click(w, d.querySelector('[data-action="nav"][data-view="family"]'));
  await tick(w, 150);
  click(w, d.querySelector('[data-action="open-add-member"]'));
  await tick(w, 150);

  assert.ok(d.querySelector("#mfEmail"), "invite form asks for an email");
  assert.ok(d.querySelectorAll('#mfExpiry [data-action="set-expiry"]').length === 3, "expiry choices offered");

  // choose 7 days
  const seven = d.querySelector('#mfExpiry [data-action="set-expiry"][data-v="7"]');
  click(w, seven);
  assert.ok(seven.classList.contains("sel"), "expiry chip becomes selected");

  d.querySelector("#mfEmail").value = "child@family.test";
  submit(w, d.querySelector("#memberForm"));
  await tick(w, 700);

  const codeEl = d.querySelector("#inviteCodeText");
  assert.ok(codeEl, "the code dialog appears");
  const code = codeEl.textContent.trim();
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  // the dialog names who the code is for
  assert.ok(d.querySelector("#modalRoot").textContent.includes("child@family.test"),
    "the dialog must say which address the code is for");
  w.close();
});

test("outstanding invites can be listed and revoked from the app", async () => {
  const { w, d } = await signInOwner();
  click(w, d.querySelector('[data-action="nav"][data-view="family"]'));
  await tick(w, 150);
  click(w, d.querySelector('[data-action="open-invites"]'));
  await tick(w, 500);

  const rows = d.querySelectorAll("#inviteList .invite-row");
  assert.ok(rows.length > 0, "outstanding invites are listed, found " + rows.length);
  // Codes themselves must never be listed, only metadata.
  assert.ok(!/\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/.test(d.querySelector("#inviteList").textContent),
    "plaintext invite codes must not be re-displayed");
  assert.ok(d.querySelector('[data-action="revoke-invite"]'), "open invites offer revoke");

  // revoke the first one
  const btn = d.querySelector('[data-action="revoke-invite"]');
  const id = btn.dataset.id;
  click(w, btn);
  await tick(w, 200);
  click(w, d.querySelector('[data-action="confirm-yes"]'));
  await tick(w, 700);

  // it should now show as revoked, and have no revoke button
  const after = d.querySelector('#inviteList [data-id="' + id + '"]');
  assert.equal(after, null, "a revoked invite is no longer revocable");
  w.close();
});

test("a revoked code can no longer be used to join", async () => {
  // Create a fresh invite, revoke it via the API, then try to register with it.
  const login = await api("POST", "/api/auth/login", {
    body: { email: "owner@family.test", password: "correct horse 1" },
  });
  const { accessToken } = login.body;

  const inv = (await api("POST", "/api/auth/household/invites", {
    body: { email: "revoked-ui@family.test" }, token: accessToken,
  })).body;

  await api("DELETE", "/api/auth/household/invites/" + inv.id, { token: accessToken });

  const attempt = await api("POST", "/api/auth/register", {
    body: { email: "revoked-ui@family.test", name: "R", password: "password123", inviteCode: inv.code },
  });
  assert.equal(attempt.status, 403);
  assert.equal(attempt.body.error, "invite_revoked");
});

test("a member (non-admin) cannot open invite management", async () => {
  // owner invites a member through the API, member joins, then checks the UI
  const login = await api("POST", "/api/auth/login", {
    body: { email: "owner@family.test", password: "correct horse 1" },
  });
  const { accessToken } = login.body;
  const inv = (await api("POST", "/api/auth/household/invites", {
    body: { email: "member-ui@family.test" }, token: accessToken,
  })).body;
  await api("POST", "/api/auth/register", {
    body: { email: "member-ui@family.test", name: "Member", password: "memberpass12", inviteCode: inv.code },
  });

  const { w, d } = openApp();
  await tick(w, 300);
  d.querySelector("#siEmail").value = "member-ui@family.test";
  d.querySelector("#siPass").value = "memberpass12";
  submit(w, d.querySelector("#signinForm"));
  await tick(w, 700);
  assert.equal(d.querySelector("#app").hidden, false, "member signed in");

  click(w, d.querySelector('[data-action="nav"][data-view="family"]'));
  await tick(w, 150);
  assert.equal(d.querySelector('[data-action="open-invites"]'), null, "members get no invites button");
  assert.equal(d.querySelector('[data-action="open-add-member"]'), null, "members cannot invite others");
  w.close();
});

test("invites default to permanent, and the UI says so", async () => {
  const { w, d } = await signInOwner();
  click(w, d.querySelector('[data-action="nav"][data-view="family"]'));
  await tick(w, 150);
  click(w, d.querySelector('[data-action="open-add-member"]'));
  await tick(w, 150);

  // The permanent option must be the selected default.
  const sel = d.querySelector('#mfExpiry .chip.sel');
  assert.ok(sel, "an expiry option is selected by default");
  assert.equal(sel.dataset.v, "", "the default must be the empty (never-expires) option");

  // And the member-facing copy must state it.
  const modalText = d.querySelector("#modalRoot").textContent;
  assert.ok(/دائم/.test(modalText), "the form should describe the code as permanent");

  d.querySelector("#mfEmail").value = "permanent-check@family.test";
  submit(w, d.querySelector("#memberForm"));
  await tick(w, 700);

  // The server must have stored no expiry at all.
  const list = await api("GET", "/api/auth/household/invites", { token: await ownerToken() });
  const inv = list.body.invites.find((i) => i.email === "permanent-check@family.test");
  assert.ok(inv, "invite was created");
  assert.equal(inv.expiresAt, null, "a permanent invite must have no expiry");
  assert.equal(inv.state, "open");
  w.close();
});

test("a member keeps working across repeated app restarts, and revocation still wins", async () => {
  // Owner invites a member, member joins, then "restarts the app" repeatedly.
  const t = await ownerToken();
  const inv = (await api("POST", "/api/auth/household/invites", {
    body: { email: "sticky@family.test" }, token: t,
  })).body;
  const join = await api("POST", "/api/auth/register", {
    body: { email: "sticky@family.test", name: "Sticky", password: "stickypass12", inviteCode: inv.code },
  });
  assert.equal(join.status, 201, join.raw);

  // Each "restart" is a brand-new JSDOM instance that must restore the session
  // from the refresh cookie alone, with no password prompt. The cookie jar is
  // carried across, exactly as the WebView's persistent jar would be.
  let jar = null;
  for (let i = 0; i < 3; i++) {
    const { w, d } = openApp(jar ? { seedCookies: jar } : {});
    if (!jar) {
      d.querySelector("#siEmail").value = "sticky@family.test";
      d.querySelector("#siPass").value = "stickypass12";
      submit(w, d.querySelector("#signinForm"));
      await tick(w, 700);
      assert.equal(d.querySelector("#app").hidden, false,
        "first launch sign-in failed: " + (d.querySelector("#authError")?.textContent || ""));
    }
    const restored = await w.FG_API.ready();
    assert.equal(restored.signedIn, true, "restart " + (i + 1) + " lost the session");
    assert.ok([...w.__jar.keys()].includes("fg_refresh"), "no session cookie to carry forward");
    jar = [...w.__jar.entries()];
    w.close();
  }

  // Now the real user-visible check: a restart must land inside the app without
  // any password prompt, purely from the carried-over cookie.
  {
    const { w, d } = openApp({ seedCookies: jar });
    await tick(w, 1000);
    assert.equal(d.querySelector("#app").hidden, false,
      "app did not auto-restore after restart; auth error = " +
      (d.querySelector("#authError")?.textContent || "none"));
    assert.equal(d.querySelector("#auth").hidden, true, "the sign-in screen must not be shown");
    assert.ok(d.querySelector("#view-dashboard").innerHTML.length > 300, "dashboard restored");
    w.close();
  }

  // Revoking must end it immediately, and sign-in must stay refused.
  const id = (await api("GET", "/api/auth/household/members", { token: t }))
    .body.members.find((m) => m.email === "sticky@family.test").id;  await api("POST", `/api/auth/household/members/${id}/disable`, { token: t });

  const { w, d } = openApp();
  await tick(w, 400);
  assert.equal((await w.FG_API.ready()).signedIn, false,
    "a revoked member must not be restored");
  d.querySelector("#siEmail").value = "sticky@family.test";
  d.querySelector("#siPass").value = "stickypass12";
  submit(w, d.querySelector("#signinForm"));
  await tick(w, 600);
  assert.equal(d.querySelector("#app").hidden, true, "revoked member must stay locked out");
  w.close();
});

test("an invite link opens Create Account with the code filled, and the name survives a restart", async () => {
  await ensureOwner();
  const t = await ownerToken();
  const inv = (await api("POST", "/api/auth/household/invites", {
    body: { email: "linked-child@family.test" }, token: t,
  })).body;

  const { w, d } = openApp({ url: "https://app.test/?code=" + encodeURIComponent(inv.code) });
  await tick(w, 600);
  assert.equal(d.querySelector("#paneJoin").hidden, false, "the invite link must open the create-account pane");
  assert.equal(d.querySelector("#jnCode").value, inv.code, "the invite code must be prefilled");
  assert.ok(d.querySelector("#paneJoin").textContent.includes("إنشاء الحساب"), "the pane is labelled Create Account");

  d.querySelector("#jnName").value = "فهد";
  d.querySelector("#jnEmail").value = "linked-child@family.test";
  d.querySelector("#jnPass").value = "linkedpass12";
  submit(w, d.querySelector("#joinForm"));
  await tick(w, 1000);

  assert.equal(d.querySelector("#app").hidden, false,
    "signup failed: " + (d.querySelector("#joinError")?.textContent || ""));
  assert.equal(w.FG_API.getUser().name, "فهد", "the chosen name is the signed-in name");
  assert.ok(d.querySelector("#view-dashboard").textContent.includes("فهد"),
    "the dashboard must greet the member by name");

  const jar = [...w.__jar.entries()];
  w.close();

  const restarted = openApp({ seedCookies: jar });
  await tick(restarted.w, 1000);
  assert.equal(restarted.d.querySelector("#app").hidden, false, "the session must survive an app restart");
  assert.equal(restarted.d.querySelector("#auth").hidden, true, "the sign-in screen must not reappear");
  assert.ok(restarted.d.querySelector("#view-dashboard").textContent.includes("فهد"),
    "the member's name must still be shown after restart");
  restarted.w.close();
});

test("an invite can be created without an email and works for exactly one account", async () => {
  await ensureOwner();
  const { w, d } = await signInOwner();
  click(w, d.querySelector('[data-action="nav"][data-view="family"]'));
  await tick(w, 150);
  click(w, d.querySelector('[data-action="open-add-member"]'));
  await tick(w, 150);

  assert.equal(d.querySelector("#mfEmail").required, false, "the email must be optional");
  submit(w, d.querySelector("#memberForm"));
  await tick(w, 700);

  const codeEl = d.querySelector("#inviteCodeText");
  assert.ok(codeEl, "a general invite code is shown");
  const code = codeEl.textContent.trim();
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.ok(d.querySelector("#modalRoot").textContent.includes("كود عام"), "the dialog labels it as a general code");
  w.close();

  const first = await api("POST", "/api/auth/register", {
    body: { email: "general-one@family.test", name: "General One", password: "generalpass1", inviteCode: code },
  });
  assert.equal(first.status, 201, first.raw);

  const second = await api("POST", "/api/auth/register", {
    body: { email: "general-two@family.test", name: "General Two", password: "generalpass2", inviteCode: code },
  });
  assert.equal(second.status, 403, second.raw);
  assert.equal(second.body.error, "invite_used");
});

test("no runtime errors across the whole invite flow", async () => {
  const { w } = await signInOwner();
  assert.equal(w.__errs.length, 0, w.__errs.join(" | "));
  w.close();
});

/**
 * Boots the API on a real HTTPS listener with a generated self-signed
 * certificate, then runs the ACTUAL www/index.html UI against it.
 *
 * This exercises the same paths a deployed HTTPS server would: the Secure
 * cookie flag in production mode, the Authorization header, no-Origin
 * requests from a native WebView, and the security headers.
 */
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "https-test-secret-definitely-long-enough-32";
process.env.REQUIRE_INVITE = "false";
process.env.SETUP_TOKEN = "";
process.env.TRUST_PROXY = "false";
process.env.AUTH_RATE_LIMIT_MAX = "1000";
process.env.DATABASE_URL = ":memory:";
process.env.CORS_ORIGINS = "";

const { makeTlsPems } = await import("./helpers/tls.js");
const { createApp } = await import("../src/index.js");

let server;
let base;
let pems;

test.before(async () => {
  pems = await makeTlsPems(["localhost", "127.0.0.1"]);
  const app = createApp();
  server = https.createServer({ key: pems.key, cert: pems.cert }, app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `https://localhost:${server.address().port}`;
});
test.after(() => server?.close());

const HTML = fs.readFileSync(path.resolve(process.cwd(), "..", "www", "index.html"), "utf8");
const API_JS = fs.readFileSync(path.resolve(process.cwd(), "..", "www", "api.js"), "utf8");

/** Minimal fetch-like wrapper over https.request, pinning the test CA. */
function request(method, path, { body, headers = {} } = {}) {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
          ...headers,
        },
        ca: pems.cert,
        servername: "localhost",
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ==================================================================== tests */

test("the server is genuinely serving TLS", async () => {
  assert.match(base, /^https:\/\//);
  const res = await request("GET", "/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  // A plaintext request to the TLS port must NOT be served.
  const plaintext = await new Promise((resolve) => {
    const s = net.connect(Number(new URL(base).port), "127.0.0.1", () => {
      s.write("GET /api/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    });
    let got = "";
    s.on("data", (c) => (got += c));
    s.on("close", () => resolve(got));
    s.on("error", () => resolve(""));
    setTimeout(() => { s.destroy(); resolve(got); }, 2000);
  });
  assert.ok(!/200 OK/.test(plaintext), "plaintext HTTP must not be answered on the TLS port");
});

test("production mode marks the refresh cookie Secure and HttpOnly", async () => {
  const res = await request("POST", "/api/auth/register", {
    body: JSON.stringify({ email: "tls-owner@fam.test", name: "Tls Owner", password: "correct horse 1" }),
  });
  assert.equal(res.status, 201, res.raw);

  const cookies = res.headers["set-cookie"] || [];
  const refresh = cookies.find((c) => c.startsWith("fg_refresh="));
  assert.ok(refresh, "refresh cookie must be issued, got: " + JSON.stringify(cookies));
  assert.match(refresh, /HttpOnly/i, "must be HttpOnly so JS cannot read it");
  assert.match(refresh, /Secure/i, "must be Secure in production");
  assert.match(refresh, /SameSite=Lax/i);
  assert.match(refresh, /Path=\/api\/auth/i);
});

test("an unauthenticated request to a protected route is refused over TLS", async () => {
  const res = await request("GET", "/api/lists/state");
  assert.equal(res.status, 401);
});

test("a native WebView (no Origin header) is accepted; an unknown Origin is not reflected", async () => {
  // Capacitor's WKWebView sends no Origin at all.
  const native = await request("GET", "/api/health");
  assert.equal(native.status, 200, "no-Origin requests must be allowed for the native app");

  // A browser-style Origin that is not allowlisted must not be echoed back.
  const hostile = await request("GET", "/api/health", { headers: { origin: "https://evil.example" } });
  assert.equal(hostile.headers["access-control-allow-origin"] ?? null, null,
    "must not reflect an unlisted origin");
});

test("security headers are present over HTTPS", async () => {
  const res = await request("GET", "/api/health");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");
  assert.ok(res.headers["content-security-policy"], "CSP must be set");
  assert.equal(res.headers["x-powered-by"], undefined, "must not advertise the framework");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
});

test("the app signs in over HTTPS and renders the dashboard", async () => {
  const vc = new VirtualConsole();
  const dom = new JSDOM(HTML, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://app.test/",
    virtualConsole: vc,
    beforeParse(w) {
      w.FG_API_BASE = base;
      w.lucide = { createIcons() {} };
      w.Chart = function () { this.destroy = () => {}; };
      w.Chart.defaults = { font: {} };
      if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
      w.scrollTo = () => {};
      w.__errs = [];
      w.addEventListener("error", (e) => w.__errs.push(String(e.error || e.message)));

      // Route the app's fetch through https.request so the test CA is trusted.
      const jar = new Map();
      w.fetch = (input, init = {}) => {
        const url = new URL(String(input));
        const headers = Object.assign({}, init.headers);
        if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
        return new Promise((resolve, reject) => {
          const r = https.request(
            {
              hostname: url.hostname, port: url.port,
              path: url.pathname + url.search,
              method: init.method || "GET",
              headers: {
                ...headers,
                ...(init.body ? { "content-type": "application/json", "content-length": Buffer.byteLength(init.body) } : {}),
              },
              ca: pems.cert, servername: "localhost",
            },
            (res) => {
              let data = "";
              res.on("data", (c) => (data += c));
              res.on("end", () => {
                for (const sc of res.headers["set-cookie"] || []) {
                  const [pair] = sc.split(";");
                  const i = pair.indexOf("=");
                  if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
                }
                const ok = res.statusCode >= 200 && res.statusCode < 300;
                resolve({
                  ok, status: res.statusCode,
                  text: async () => data,
                  json: async () => JSON.parse(data || "null"),
                  headers: { get: (k) => res.headers[String(k).toLowerCase()] ?? null },
                });
              });
            },
          );
          r.on("error", reject);
          if (init.body) r.write(init.body);
          r.end();
        });
      };
      w.eval(API_JS);
    },
  });
  const w = dom.window, d = w.document;
  w.localStorage.clear();
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(d.querySelector("#paneSignin").hidden, false, "connected mode over HTTPS");
  assert.equal(d.querySelector("#paneLocal").hidden, true, "must not offer local mode when a server is set");

  d.querySelector("#siEmail").value = "tls-owner@fam.test";
  d.querySelector("#siPass").value = "correct horse 1";
  d.querySelector("#signinForm").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 800));

  assert.equal(d.querySelector("#app").hidden, false,
    "signed in over HTTPS; error = " + (d.querySelector("#authError")?.textContent || ""));
  assert.ok(d.querySelector("#view-dashboard").innerHTML.length > 300, "dashboard rendered");
  assert.equal(w.__errs.length, 0, w.__errs.join(" | "));
  w.close();
});

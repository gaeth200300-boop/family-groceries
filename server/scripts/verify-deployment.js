#!/usr/bin/env node
/**
 * Verifies a DEPLOYED server before you rely on it.
 *
 *   node scripts/verify-deployment.js --url https://api.example.com
 *   node scripts/verify-deployment.js --url https://api.example.com --email me@x.com --password '...'
 *
 * With --email/--password it also performs a real sign-in and an authenticated
 * read, proving the whole chain works end to end from outside.
 */
import crypto from "node:crypto";

function arg(name, fallback = null) {
  const i = process.argv.indexOf("--" + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes("--" + name);

const raw = (arg("url") || process.env.FG_API_URL || "").replace(/\/+$/, "");
const email = arg("email");
const password = arg("password");

const results = [];
const ok = (n, d) => results.push({ n, p: true, d: d || "" });
const no = (n, d) => results.push({ n, p: false, d: d || "" });
const chk = (n, c, d) => (c ? ok(n, d) : no(n, d));

if (!raw) {
  console.error("\n  Usage: node scripts/verify-deployment.js --url https://api.example.com [--email ... --password ...]\n");
  process.exit(1);
}
const base = raw;

async function get(path, init = {}) {
  const res = await fetch(base + path, { redirect: "manual", ...init });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, body, raw: text, url: res.url };
}

console.log("\n  Verifying " + base + "\n");

/* ------------------------------------------------------------- 1. TLS + basics */
let health;
try {
  health = await get("/api/health");
} catch (e) {
  const code = e.cause?.code || e.code || "";
  console.error("\n  UNREACHABLE: " + code + " " + e.message + "\n");
  if (/CERT|SSL|TLS|DEPTH|SELF|UNABLE_TO_VERIFY/i.test(code)) {
    console.error("  This looks like a TLS certificate problem, not a network one.");
    console.error("  A self-signed or untrusted certificate will be rejected by App Review");
    console.error("  and by real devices. Use a certificate from a public CA (Let's Encrypt via");
    console.error("  your platform's HTTPS, Caddy, or nginx) and confirm the full chain is served.\n");
  } else {
    console.error("  Check DNS, the certificate, and that the service is listening.\n");
  }
  process.exit(1);
}

chk("server responds over HTTPS", base.startsWith("https://"), base);
chk("health endpoint returns ok", health.status === 200 && health.body?.ok === true,
  "status " + health.status);
chk("no redirect to another host", health.url.startsWith(base), health.url);

/* --------------------------------------------------------- 2. certificate */
if (base.startsWith("https://")) {
  try {
    // Node validates the chain by default; a self-signed or expired cert throws.
    await fetch(base + "/api/health", { redirect: "manual" });
    ok("TLS certificate is publicly trusted", "node accepted the chain with no overrides");
  } catch (e) {
    no("TLS certificate is publicly trusted",
      "node rejected it: " + (e.cause?.code || e.message) +
      " — App Review and real devices will reject it too");
  }
} else {
  results.push({
    n: "TLS certificate is publicly trusted",
    p: null,
    d: "skipped — this URL is not https, so there is no certificate to check",
  });
}

/* ------------------------------------------------------------ 3. headers */
chk("HSTS present (set by your proxy)", !!health.headers.get("strict-transport-security"),
  health.headers.get("strict-transport-security") || "MISSING — add it at the proxy");
chk("X-Content-Type-Options: nosniff", health.headers.get("x-content-type-options") === "nosniff");
chk("X-Frame-Options present", !!health.headers.get("x-frame-options"),
  health.headers.get("x-frame-options") || "missing");
chk("Content-Security-Policy present", !!health.headers.get("content-security-policy"));
chk("does not advertise Express", !health.headers.get("x-powered-by"));

/* ------------------------------------------------ 4. auth is actually gated */
const anon = await get("/api/lists/state");
chk("protected route refuses anonymous access", anon.status === 401, "status " + anon.status);

const badLogin = await get("/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "definitely-not-registered@invalid.test", password: "wrong password 1" }),
});
chk("unknown account is rejected", badLogin.status === 401, "status " + badLogin.status);

/* --------------------------------------------- 5. invite gate is enforced */
const noInvite = await get("/api/auth/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: `probe-${crypto.randomBytes(6).toString("hex")}@invalid.test`, name: "Probe", password: "probe password 1" }),
});
const gated = noInvite.status === 403 &&
  ["invite_required", "invite_invalid", "invite_revoked", "invite_expired", "invite_used"].includes(noInvite.body?.error);
chk("registration requires an invite (no open sign-up)", gated,
  "status " + noInvite.status + " / " + (noInvite.body?.error || noInvite.raw.slice(0, 80)));

/* ------------------------------------- 6. malformed input handled cleanly */
const badJson = await get("/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{not json",
});
chk("malformed JSON returns a clean 400", badJson.status === 400 && !!badJson.body?.error,
  "status " + badJson.status);

const badToken = await get("/api/lists/state", { headers: { authorization: "Bearer nonsense" } });
chk("forged token is refused", badToken.status === 401, "status " + badToken.status);

/* ---------------------------------- 7. optional: real sign-in + read */
if (email && password) {
  try {
    const login = await get("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (login.status !== 200) {
      no("sign in with the supplied credentials", "status " + login.status + " — " + (login.body?.message || ""));
    } else {
      ok("sign in with the supplied credentials", "user " + login.body.user.email);
      chk("refresh cookie is Secure", /Secure/i.test(login.headers.get("set-cookie") || ""),
        (login.headers.get("set-cookie") || "no cookie"));
      chk("refresh cookie is HttpOnly", /HttpOnly/i.test(login.headers.get("set-cookie") || ""));

      const state = await get("/api/lists/state", {
        headers: { authorization: "Bearer " + login.body.accessToken },
      });
      chk("authenticated read of household state", state.status === 200 && !!state.body,
        "status " + state.status);
      chk("state payload contains no password hash", !/scrypt\$/.test(state.raw));

      const me = await get("/api/auth/me", {
        headers: { authorization: "Bearer " + login.body.accessToken },
      });
      chk("GET /auth/me returns the account", me.status === 200 && me.body?.user?.email === email);
    }
  } catch (e) {
    no("sign in with the supplied credentials", e.message);
  }
} else {
  results.push({ n: "authenticated round-trip", p: null, d: "skipped — pass --email and --password" });
}

/* ------------------------------------------------------------------ report */
const pass = results.filter((r) => r.p === true).length;
const fail = results.filter((r) => r.p === false).length;
const skip = results.filter((r) => r.p === null).length;

console.log("  " + "-".repeat(64));
for (const r of results) {
  const mark = r.p === true ? "PASS" : r.p === false ? "FAIL" : "SKIP";
  console.log("  " + mark + "  " + r.n + (r.d ? "  [" + r.d + "]" : ""));
}
console.log("  " + "-".repeat(64));
console.log("  " + pass + " passed, " + fail + " failed, " + skip + " skipped\n");

if (fail) {
  console.log("  Do NOT submit the app until every FAIL above is resolved.\n");
  process.exit(1);
}
console.log("  Server looks healthy. Next: set FG_API_BASE in www/index.html,");
console.log("  run `npx cap sync ios`, then test on a real device.\n");

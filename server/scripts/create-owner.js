#!/usr/bin/env node
/**
 * Creates the household owner account on a deployed server.
 *
 * The first account registered on an empty database becomes the owner and the
 * only admin. There is exactly one such slot, so run this yourself immediately
 * after deploying — otherwise whoever registers first owns the household.
 *
 * Usage:
 *   node scripts/create-owner.js --url https://api.example.com
 *   node scripts/create-owner.js --url https://api.example.com --email me@x.com --name Me
 *
 * If the server refuses with invite_required, set REQUIRE_INVITE=false, restart,
 * run this, then set it back to true and restart again.
 */
import crypto from "node:crypto";

function arg(name, fallback = null) {
  const i = process.argv.indexOf("--" + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = (arg("url") || process.env.FG_API_URL || "").replace(/\/+$/, "");
const email = arg("email");
const name = arg("name") || "Owner";
const password = arg("password") || crypto.randomBytes(12).toString("base64url");
const setupToken = arg("setup-token") || process.env.SETUP_TOKEN || "";
const generated = !arg("password");

if (!url) {
  console.error("\n  Missing --url. Example:\n    node scripts/create-owner.js --url https://api.example.com --email you@example.com\n");
  process.exit(1);
}
if (!email) {
  console.error("\n  Missing --email.\n");
  process.exit(1);
}

if (!/^https:\/\//i.test(url) && !/^http:\/\/localhost|^http:\/\/127\.0\.0\.1/i.test(url)) {
  console.warn("\n  WARNING: " + url + " is not HTTPS. Cookies will not be Secure and the");
  console.warn("  App Store will reject an app that talks plaintext HTTP.\n");
}

if (generated) {
  // Reject anything the server's own policy would reject.
  if (password.length < 10 || !/[0-9]/.test(password)) {
    console.error("  Generated password failed the policy; aborting.");
    process.exit(1);
  }
}

console.log("\n  Creating the household owner");
console.log("  server : " + url);
console.log("  email  : " + email);
console.log("  name   : " + name);
if (generated) console.log("  pass   : (generated below — save it now)\n");
else console.log("");

let res;
try {
  res = await fetch(url + "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email, name, password,
      householdName: arg("household") || "عائلتي",
      ...(setupToken ? { setupToken } : {}),
    }),
  });
} catch (e) {
  console.error("  Could not reach the server: " + e.message);
  console.error("  Check the URL, DNS, TLS certificate and firewall.\n");
  process.exit(1);
}

const text = await res.text();
let body = null;
try { body = JSON.parse(text); } catch { /* not JSON */ }

if (res.status !== 201) {
  console.error("  FAILED (" + res.status + ")");
  console.error("  " + (body?.message || text.slice(0, 300)));
  if (body?.error === "setup_token_required") {
    console.error("\n  This server is unclaimed and requires a one-time setup token.");
    console.error("  Pass it explicitly:\n");
    console.error("    node scripts/create-owner.js --url " + url + " --email " + email +
      " \\\n      --setup-token \"$SETUP_TOKEN\"\n");
    console.error("  The token is the SETUP_TOKEN value in the server's environment.\n");
  }
  if (body?.error === "invite_required") {
    console.error("\n  This server requires an invite even for the first account.");
    console.error("  Set SETUP_TOKEN in the environment and pass --setup-token, which");
    console.error("  lets you keep REQUIRE_INVITE=true permanently.\n");
  }
  if (body?.error === "email_taken") {
    console.error("\n  An account with that email already exists. Use the existing password,\n");
    console.error("  or create a different owner email.\n");
  }
  process.exit(1);
}

console.log("  SUCCESS — household created\n");
console.log("  household id : " + body.user.householdId);
console.log("  user id      : " + body.user.id);
console.log("  role         : " + body.user.role);
if (generated) {
  console.log("\n  ┌──────────────────────────────────────────────┐");
  console.log("  │  OWNER PASSWORD (shown once — save it now)   │");
  console.log("  └──────────────────────────────────────────────┘");
  console.log("  " + password + "\n");
}
console.log("  Next steps:");
console.log("   1. Confirm REQUIRE_INVITE=true and restart the server.");
console.log("   2. Sign in to the app with the credentials above.");
console.log("   3. In the app: العائلة → دعوة عضو، to invite your family.");
console.log("   4. Set FG_API_BASE in www/index.html and run: npx cap sync ios\n");

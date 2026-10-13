#!/usr/bin/env node
/**
 * Real-device readiness audit for the iOS app.
 *
 * Everything here is checked statically against the project on disk. It cannot
 * compile or run the app (that needs macOS + Xcode), so it verifies the things
 * that are checkable and prints the steps that are not.
 *
 *   node server/scripts/device-readiness.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const IOS = path.join(root, "ios", "App");        // holds App.xcodeproj
const SRC = path.join(IOS, "App");                // holds Info.plist, storyboards, assets, public
const WWW = path.join(root, "www");

const results = [];
const chk = (n, pass, detail = "", level = "fail") =>
  results.push({ n, level: pass ? "pass" : level, d: detail });
const note = (n, d) => results.push({ n, level: "note", d: d || "" });

const read = (p) => fs.readFileSync(p, "utf8");
const exists = (p) => fs.existsSync(p);

/* ------------------------------------------------------- 1. project structure */
chk("Xcode project present", exists(path.join(IOS, "App.xcodeproj/project.pbxproj")));
chk("Info.plist present", exists(path.join(SRC, "Info.plist")));
chk("LaunchScreen storyboard present", exists(path.join(SRC, "Base.lproj/LaunchScreen.storyboard")));
chk("Main storyboard present", exists(path.join(SRC, "Base.lproj/Main.storyboard")));

/* ------------------------------------------------------------- 2. Info.plist */
const plist = read(path.join(SRC, "Info.plist"));
chk("CFBundleIdentifier uses $(PRODUCT_BUNDLE_IDENTIFIER)", plist.includes("$(PRODUCT_BUNDLE_IDENTIFIER)"));
chk("CFBundleDisplayName set (Arabic)", /<key>CFBundleDisplayName<\/key>\s*<string>\S/.test(plist),
  "display name present");
chk("CFBundleShortVersionString uses $(MARKETING_VERSION)", plist.includes("$(MARKETING_VERSION)"));
chk("CFBundleVersion uses $(CURRENT_PROJECT_VERSION)", plist.includes("$(CURRENT_PROJECT_VERSION)"));
chk("export compliance declared (ITSAppUsesNonExemptEncryption)",
  /ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/.test(plist),
  "without this every upload stalls on a compliance prompt");
chk("UILaunchStoryboardName set", plist.includes("<string>LaunchScreen</string>"));
chk("UIMainStoryboardFile set", plist.includes("<string>Main</string>"));
chk("deprecated armv7 capability removed", !plist.includes("armv7"),
  "armv7 is a 32-bit marker; harmless but stale in a modern build");

/* ------------------------------------------------------------ 3. pbxproj */
const pbx = read(path.join(IOS, "App.xcodeproj/project.pbxproj"));
const grab = (re) => (pbx.match(re) || [])[1];
chk("PRODUCT_BUNDLE_IDENTIFIER set", !!grab(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/), grab(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/));
chk("IPHONEOS_DEPLOYMENT_TARGET is 13.0+", (() => {
  const m = grab(/IPHONEOS_DEPLOYMENT_TARGET = ([0-9.]+);/);
  return m && parseFloat(m) >= 13.0;
})(), grab(/IPHONEOS_DEPLOYMENT_TARGET = ([^;]+);/));
chk("SWIFT_VERSION set", !!grab(/SWIFT_VERSION = ([^;]+);/), grab(/SWIFT_VERSION = ([^;]+);/));
chk("MARKETING_VERSION set", !!grab(/MARKETING_VERSION = ([^;]+);/), grab(/MARKETING_VERSION = ([^;]+);/));
chk("CURRENT_PROJECT_VERSION set (build number)", !!grab(/CURRENT_PROJECT_VERSION = ([^;]+);/), grab(/CURRENT_PROJECT_VERSION = ([^;]+);/));

/* --------------------------------------------------- 4. privacy manifest */
const privacyPath = path.join(SRC, "PrivacyInfo.xcprivacy");
chk("PrivacyInfo.xcprivacy exists", exists(privacyPath));
if (exists(privacyPath)) {
  const p = read(privacyPath);
  chk("  XML declaration is first (a comment before it is invalid)", p.trimStart().startsWith("<?xml"));
  chk("  NSPrivacyTracking declared false", /NSPrivacyTracking<\/key>\s*<false\/>/.test(p));
  chk("  required-reason APIs declared", p.includes("NSPrivacyAccessedAPITypes"));
  const refs = (pbx.match(/PrivacyInfo\.xcprivacy/g) || []).length;
  chk("  registered in the Xcode project", refs >= 4,
    `${refs} references (need file ref, build file, Resources phase, group)`);
}

/* ---------------------------------------------------------- 5. app icon */
const iconDir = path.join(SRC, "Assets.xcassets/AppIcon.appiconset");
const iconJson = path.join(iconDir, "Contents.json");
chk("AppIcon Contents.json present", exists(iconJson));
if (exists(iconJson)) {
  const j = JSON.parse(read(iconJson));
  const entry = j.images.find((i) => /1024x1024/.test(i.size || ""));
  chk("  1024x1024 App Store icon declared", !!entry,
    entry ? entry.filename : "not found in " + JSON.stringify(j.images.map((i) => i.size)));
  if (entry && entry.filename) {
    const p = path.join(iconDir, entry.filename);
    chk("  icon file present", exists(p));
    if (exists(p)) {
      const b = fs.readFileSync(p);
      // PNG: 8-byte sig, then IHDR; width/height at 16..23, bit depth 24, colour type 25
      const isPng = b.subarray(0, 8).every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i]);
      chk("  icon is a valid PNG", isPng);
      if (isPng) {
        const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
        const colorType = b[25];
        chk("  icon is 1024x1024", w === 1024 && h === 1024, `${w}x${h}`);
        chk("  icon has NO alpha channel (Apple rejects alpha)",
          colorType === 2, `PNG colour type ${colorType} (2 = RGB, 6 = RGBA)`);
      }
    }
  }
}

/* -------------------------------------------------- 6. web assets in bundle */
const pub = path.join(SRC, "public");
chk("web assets copied into the native project", exists(path.join(pub, "index.html")));
if (exists(path.join(pub, "index.html"))) {
  const a = read(path.join(WWW, "index.html"));
  const b = read(path.join(pub, "index.html"));
  chk("  bundle matches www/ (run npx cap sync ios if not)", a === b,
    a === b ? "identical" : "STALE — the iOS bundle is out of date");
}
chk("api.js shipped in the bundle", exists(path.join(pub, "api.js")),
  "the app cannot authenticate without it");
chk("service worker shipped (you asked to keep it)", exists(path.join(pub, "sw.js")));
chk("app icon referenced by the web manifest", exists(path.join(WWW, "icons/icon-180.png")));

/* -------------------------------------------------- 7. server configuration */
const idx = exists(path.join(WWW, "index.html")) ? read(path.join(WWW, "index.html")) : "";
const baseMatch = idx.match(/window\.FG_API_BASE\s*=\s*window\.FG_API_BASE\s*\|\|\s*'([^']*)'/);
const configuredBase = baseMatch ? baseMatch[1] : null;
chk("FG_API_BASE is a constant in index.html", baseMatch !== null);
chk("FG_API_BASE is set to your HTTPS server", !!configuredBase && configuredBase.startsWith("https://"),
  configuredBase ? `"${configuredBase}"` : "still empty — the app will run local-only, so no shared data");
note("  set it here: www/index.html, then run: npx cap sync ios");

/* --------------------------------------------------------- 8. what I cannot do */
note("App Transport Security", "the app ships no ATS exception, so it requires HTTPS. Correct for production; a plain http:// test server will be blocked by iOS.");
note("Signing", "needs your Apple Developer team in Xcode → Signing & Capabilities. Cannot be set here.");
note("Build + install", "needs macOS with Xcode. Run: npx cap sync ios && npx cap open ios");
note("Screenshots", "must be captured on a device or simulator; not scriptable from here.");

/* ------------------------------------------------------------------ report */
const pass = results.filter((r) => r.level === "pass").length;
const fail = results.filter((r) => r.level === "fail").length;
const notes = results.filter((r) => r.level === "note").length;

console.log("\n  REAL-DEVICE READINESS AUDIT\n  " + "-".repeat(66));
for (const r of results) {
  const mark = r.level === "pass" ? "PASS" : r.level === "fail" ? "FAIL" : "NOTE";
  console.log("  " + mark + "  " + r.n + (r.d ? "\n          " + r.d : ""));
}
console.log("  " + "-".repeat(66));
console.log("  " + pass + " passed, " + fail + " failed, " + notes + " notes\n");

if (fail) {
  console.log("  Fix the FAIL items above before testing on a device.\n");
  process.exit(1);
}
console.log("  Static checks pass. Next: deploy the server, create the owner account,");
console.log("  then build on a Mac and install on a real iPhone.\n");

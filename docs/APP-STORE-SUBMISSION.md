# App Store Submission Guide — مقاضي العائلة (Family Groceries)

Read this end to end before starting. Two things gate everything else and
neither can be done from this repo.

---

## 0. The two hard blockers

| Blocker | Why it stops you | What to do |
|---|---|---|
| **No Apple Developer Program membership** | No signing identity → no build → no upload. The App Store is completely unreachable without it. | Enrol at <https://developer.apple.com/programs/enroll/> — $99/yr, usually approved in 24–72 h. |
| **No macOS + Xcode** | Capacitor produces an Xcode project, not an IPA. Compiling, archiving and signing require Xcode on a Mac. | Any Mac with Xcode 15+ and a free Apple ID works for building. Upload needs a paid membership. |

Everything in this repository is prepared so that once you have those two, the
remaining work is mechanical.

---

## 1. Choosing the distribution method — read this first

You asked for an app "for a specific group of people, not for everyone".
Apple has **no invite-only tier in the public App Store**. The options:

| Method | Who can install | Searchable | Needs review | Best for |
|---|---|---|---|---|
| **TestFlight (external)** | Only the email addresses you add | No | Beta App Review (lighter) | ✅ **Recommended for you** — genuinely restricted to people you choose |
| **Unlisted App Store** | Anyone with the link | No | Full App Review | Stable, permanent release to a known group — but *not* access-controlled |
| **Custom App (Apple Business Manager)** | Members of one organisation | No | Full App Review | A company, not a family |
| **Public App Store** | Everyone | Yes | Full App Review | Contradicts your requirement |

**Recommendation:** release through **TestFlight external testing**. It is the
only option where the install list is genuinely limited to people you name.
Trade-off: TestFlight builds expire after **90 days**, so you re-upload a build
roughly four times a year. That is a small, scripted chore.

If you later want a permanent install link for the same group, switch the same
build to **Unlisted** distribution. Same binary, no new code.

---

## 2. Reviewer access — the most common rejection for invite-only apps

Guideline **2.1 (App Completeness)** requires the review team to be able to use
the app. An app that locks everyone out without a code will be rejected.

Two options:

**A. A seeded reviewer account (recommended).** Before submitting, create a
household and account that the reviewers can use, then put the credentials in
the App Store Connect "Review Information" notes field:

```
Demo account for review
-----------------------
1. Open the app. On the sign-in screen tap "تسجيل الدخول".
2. Sign in with the credentials below.
3. The shared grocery list is immediately visible; add or tick any item.

Email:    reviewer@example.com
Password: <generated strong password>
```

The reviewer does **not** need an invite code if you create the account for them
directly on the server (`POST /api/auth/register` with `REQUIRE_INVITE=false` on
a fresh database, or by inviting then registering).

**B. A `REVIEW_MODE` bypass.** The server supports disabling the invite gate for
the first signup only:

```
REQUIRE_INVITE=false   # first signup bootstraps a household
```

Turn this **off again** (`REQUIRE_INVITE=true`) once the reviewer account exists.
Never ship with it false — with an empty database, whoever registers first
becomes the owner.

---

## 3. Backend must be live before you submit

Because the app is gated behind a login, **the server must be publicly reachable
over HTTPS at submission time** or the reviewer sees a blank app.

- Deploy per `docs/DEPLOYMENT.md`.
- Terminate TLS (the platform's HTTPS, or nginx/Caddy in front).
- Set `TRUST_PROXY=true` and `REQUIRE_INVITE=true` in production.
- The app is pointed at your server via `FG_API_BASE` (see §6).

**If you cannot deploy yet**, the honest alternative is to submit a build that
still runs local-only. Decide before you start; it changes what you claim in the
privacy answers.

---

## 4. Account deletion — mandatory (Guideline 5.1.1(v))

Because the app supports account creation, it **must** let a user delete their
account **inside the app**, without contacting you.

This is implemented end to end:

- Server: `DELETE /api/auth/account` (`server/src/routes/auth.js`)
- Client: `FG_API.deleteAccount()` (`www/api.js`)
- Covered by an automated test in both suites.

Before submitting, verify by hand: sign in → account settings → delete account
→ the account is gone and cannot be signed into again.

---

## 5. Privacy — declarations must be accurate

The app collects nothing for tracking and shares nothing with Apple. It *does*
send household data (emails, names, grocery items) to **your own server**.

In **App Store Connect → App Privacy**, answer:

| Question | Answer |
|---|---|
| Do you or your third-party partners collect data from this app? | **Yes** |
| Do you use data for tracking? | **No** |
| Data types | Contact Info → Email Address; Contact Info → Name; User Content |
| Linked to user identity? | **Yes** |
| Purpose | **App Functionality** only |
| Shared with third parties? | **No** |

These must match `ios/App/App/PrivacyInfo.xcprivacy`, which declares:

- `NSPrivacyTracking` = `false`
- `NSPrivacyTrackingDomains` = empty
- Collected types: EmailAddress, Name, UserContent — all linked, none tracking
- Required-reason APIs: UserDefaults (`CA92.1`), FileTimestamp (`C617.1`)

**Privacy policy URL is required** for App Store Connect. Publish
`docs/PRIVACY-POLICY.md` somewhere publicly reachable (GitHub Pages, Netlify,
your domain) and use that URL.

---

## 6. Pointing the app at your server

The app runs in **two modes** and picks automatically:

| Mode | When | Behaviour |
|---|---|---|
| **Connected** | A server URL is set **and** you are signed in | Data lives on your server and is shared with the household. Requires a real email + password account. |
| **Local** | No server URL, or signed out | Everything stays on this device. No password; you pick a local profile. |

This means the app is never a dead screen — if the server is unreachable or you
clear the URL, it still works as a private single-device grocery list.

### Setting the URL

At runtime, via **إعدادات الخادم** on the sign-in screen (stored in
`localStorage['fg_api_base']`).

For a real build, hard-code it at the top of `www/index.html` (line ~665):

```html
<script>window.FG_API_BASE = 'https://api.your-domain.com';</script>
```

Then rebuild the web assets:

```bash
npx cap sync ios
```

**ATS:** iOS blocks plaintext HTTP by default. If — and only while testing — you
point the app at `http://`, add an ATS exception. For production use HTTPS so no
exception is needed.

### The screens

- **تسجيل الدخول** — email + password (connected mode)
- **انضمام بكود** — name, email, new password, invite code
- **إعداد العائلة** — first-run only, creates the household owner
- **حسابي** — account settings: change password, sign out, and **delete account**

The local-mode profile picker appears automatically when no server is set.

---

## 7. Build, sign, upload (on a Mac)

```bash
# 1. Fetch the web assets into the native project
npm install
npx cap sync ios

# 2. Install CocoaPods dependencies
cd ios/App && pod install && cd ../..

# 3. Open in Xcode
npx cap open ios
```

In Xcode:

1. Select the **App** target → **Signing & Capabilities**
2. Choose your Team (your Apple ID / organisation)
3. If changing the bundle ID, also update `PRODUCT_BUNDLE_IDENTIFIER` and
   `server/src` has no dependency on it, but App Store Connect must match exactly
4. **Product → Destination → Any iOS Device (arm64)**
5. Bump **Build** in *General → Version* for every upload
6. **Product → Archive**
7. In the Organizer: **Distribute App → App Store Connect → Upload**
8. Answer the export-compliance prompt (**no encryption** — already declared via
   `ITSAppUsesNonExemptEncryption = false`)

### Versioning

`ios/App/App.xcodeproj/project.pbxproj` currently has:

- `MARKETING_VERSION = 1.0` → shown to users; bump for a new release
- `CURRENT_PROJECT_VERSION = 1` → build number; **must increase on every upload**

For TestFlight, bump the build number for each 90-day refresh even if nothing
changed.

---

## 8. Metadata to supply in App Store Connect

| Field | Value | Limit |
|---|---|---|
| Name | `مقاضي العائلة` | 30 chars |
| Subtitle | `قائمة مقاضي عائلتك المشتركة` | 30 chars |
| Bundle ID | `com.family.groceries` | must match the signed build |
| SKU | `FAMGROC001` | unique, internal |
| Primary category | `Food & Drink` | |
| Secondary | `Productivity` | |
| Age rating | 4+ | no objectionable content |
| Keywords | `groceries,shopping,list,family,مقاضي,تسوق,عائلة` | 100 chars |
| Support URL | your site | required |
| Marketing URL | optional | |
| Privacy policy URL | your hosted policy | **required** |
| Copyright | `2026 <your name>` | |

### Screenshots — you must capture these yourself

App Store Connect requires at least one set. Required iPhone size:

- **6.9" / 6.7"** — 1290 × 2796 px (or 1320 × 2868, 1290 × 2796)
- **6.5"** — 1242 × 2688 px

They cannot be generated here — they need a running build on a device or
simulator. Suggested shots, in order:

1. Dashboard — budget bar, tiles, weekly list
2. Shopping mode — item check-off, live budget remaining
3. History — an archived week expanded with the receipt
4. Family — members and roles
5. Sign-in screen — to show the invite gate

Screenshots may contain Arabic text, but add localised (Arabic) screenshots if
you want the App Store to show the Arabic store listing.

---

## 9. Pre-submission checklist

**Configuration**
- [ ] Bundle ID in Xcode matches App Store Connect exactly
- [ ] `CURRENT_PROJECT_VERSION` incremented
- [ ] `CFBundleDisplayName` is exactly `مقاضي العائلة` (no stray characters)
- [ ] App icon is 1024×1024, PNG, **no alpha channel** (already verified: RGB)
- [ ] `PrivacyInfo.xcprivacy` present in the target (registered in 4 pbxproj sections)
- [ ] `ITSAppUsesNonExemptEncryption` = `false`
- [ ] Launch screen present, no placeholder text

**Backend**
- [ ] Server reachable over HTTPS from the public internet
- [ ] `JWT_SECRET` is 32+ random characters and **not** the example value
- [ ] `REQUIRE_INVITE=true`
- [ ] `TRUST_PROXY=true`
- [ ] Reviewer account created; credentials in the review notes
- [ ] `GET /api/health` returns `{"ok":true}`
- [ ] Database backed up

**Compliance**
- [ ] Privacy policy published at a public URL
- [ ] App Privacy answers match the privacy manifest
- [ ] Account deletion reachable in-app and verified by hand
- [ ] Age rating questionnaire completed

**Build**
- [ ] Archive succeeds with no warnings that block upload
- [ ] Validate App in Organizer before upload
- [ ] TestFlight build installed and signed in on a real device

---

## 10. Honest limitations

Please be aware of these before you promise this to your family:

- **Data is on your server, not Apple's.** If you stop paying for hosting, the
  app breaks. There is no local fallback once a household has synced.
- **No push notifications.** The app polls on open; it will not alert anyone
  that a list changed while closed.
- **Last-write-wins sync.** If two people edit the same item at the same moment,
  the later write wins. Fine for a shopping list; not a collaborative document.
- **Images are stored inline as base64** in the database (capped at 3 MB per
  request). Fine for receipts; not a photo library.
- **The 90-day TestFlight clock** applies. Unlisted distribution avoids it but
  loses the access restriction.

# Deployment — Family Groceries API

The server is a single Node process with a SQLite file. There is no build step,
no native compilation, and no external database to provision.

---

## Requirements

- **Node.js 22.5 or newer** (uses the built-in `node:sqlite`)
- A host with a public HTTPS endpoint

Verify: `node -v`

---

## 1. Configure

```bash
cd server
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# paste that into JWT_SECRET in .env
```

Production settings — these matter:

```ini
NODE_ENV=production
REQUIRE_INVITE=true      # only invited people may create an account
TRUST_PROXY=true         # behind a TLS-terminating proxy
DATABASE_URL=/data/app.db
JWT_SECRET=<32+ random chars>
```

The server **refuses to start** if `JWT_SECRET` is still the example value while
`NODE_ENV=production`. Rotating `JWT_SECRET` signs everyone out.

---

## 2. Run it

```bash
npm install --omit=dev
npm start
```

Check it:

```bash
curl https://api.your-domain.com/api/health
# {"ok":true,"service":"family-groceries","time":"..."}
```

---

## 3. Create the household owner

The very first account to register becomes the household owner. There is exactly
one first-run slot, so do this yourself immediately after deploying — otherwise
whoever registers first owns the household.

```bash
cd server
npm run create-owner -- --url https://api.your-domain.com --email you@example.com
```

This prints a generated password **once** — save it. If you omit `--password`
one is generated for you.

If the server refuses with `invite_required`, the gate is on (as it should be):

```bash
# temporarily allow the first-run signup
REQUIRE_INVITE=false        # in .env / secret store
# restart, then:
npm run create-owner -- --url https://api.your-domain.com --email you@example.com
# restore immediately
REQUIRE_INVITE=true
# restart again
```

Then, inside the app: **العائلة → دعوة عضو** to create an invite code for each
family member. The code is shown once; only its hash is stored.

---

## 3b. Verify the deployment before trusting it

```bash
npm run verify-deployment -- --url https://api.your-domain.com
npm run verify-deployment -- --url https://api.your-domain.com \
  --email you@example.com --password '...'
```

This checks, from the outside:

- HTTPS actually in use, no cross-host redirect
- TLS certificate trusted by Node (a self-signed cert **will** fail this, which
  is the point — App Review and real devices reject those too)
- HSTS, `nosniff`, `X-Frame-Options`, CSP, no `X-Powered-By`
- protected routes refuse anonymous access
- unknown accounts are rejected
- **registration really is invite-gated** (no open sign-up)
- malformed JSON and forged tokens handled cleanly
- with `--email/--password`: a real sign-in, a `Secure`+`HttpOnly` refresh cookie,
  an authenticated read, and no password hash in the response

Do not submit the app while anything reports FAIL.

A quick Caddy config in front of Node if your platform does not terminate TLS:

```
api.your-domain.com {
  reverse_proxy localhost:8787
}
```

Caddy provisions and renews a Let's Encrypt certificate automatically.

---

## 4. Hosting options

Any of these work. Pick on cost and how much you want to manage.

### Fly.io (recommended — persistent volume, simple)

```bash
fly launch --name family-groceries --no-deploy
fly volumes create groceries_data --size 1     # 1 GB
fly secrets set JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
fly secrets set NODE_ENV=production REQUIRE_INVITE=true TRUST_PROXY=true
fly deploy
```

Fly gives you HTTPS automatically at `https://<app>.fly.dev`.

### Render

- Web Service, Node runtime
- Attach a **Disk** mounted at `/data`, set `DATABASE_URL=/data/app.db`
- Environment variables in the dashboard
- Free tier sleeps and **loses ephemeral disk** — use the paid tier with a disk

### Docker (any VPS)

```bash
docker build -t family-groceries .
docker run -d --name fg \
  -p 8787:8787 \
  -v fgdata:/data \
  -e NODE_ENV=production \
  -e REQUIRE_INVITE=true \
  -e TRUST_PROXY=true \
  -e DATABASE_URL=/data/app.db \
  -e JWT_SECRET="$(openssl rand -base64 32)" \
  family-groceries
```

Put Caddy or nginx in front for TLS. A minimal Caddyfile:

```
api.your-domain.com {
  reverse_proxy localhost:8787
}
```

Caddy obtains and renews a Let's Encrypt certificate automatically.

---

## 5. Backups

The whole state of the app is one SQLite file. Back it up with `sqlite3`:

```bash
sqlite3 /data/app.db ".backup '/backups/fg-$(date +%F).db'"
```

Keep a copy off the host. A daily cron is plenty for a family grocery list.

To restore, stop the app, replace the file, start it again.

---

## 6. Security notes

What the server does:

- Passwords hashed with **scrypt** (N=32768, r=8, p=1) and a per-user random
  salt. Never stored or logged in plaintext.
- Access tokens are short-lived signed JWTs (15 min default). The refresh token
  is opaque, single-use, **rotated on every refresh**, and stored server-side as
  a hash — a stolen database cannot be replayed.
- **Every query is scoped to the caller's household**, taken from the signed
  token, never from client input. Cross-household access returns 404.
- Registration, login and password change are IP rate-limited.
- Login responses are identical for "no such user" and "wrong password", and a
  dummy hash comparison runs when the account does not exist, so response timing
  does not reveal whether an email is registered.
- Disabling a member revokes their refresh tokens immediately, and their
  existing access token stops working on the very next request.
- Security headers via `helmet`, including a CSP with `object-src 'none'`.
- An audit log records sign-in, sign-up, password change, account deletion,
  invite creation/revocation and role changes.

What it does **not** do — be aware:

- **No email verification.** An invite can be bound to an address but the
  address is never confirmed. For a family group that is a deliberate
  simplification; it is not appropriate for a public sign-up.
- **No password reset flow.** An admin must remove and re-invite the member.
  This is a real gap for App Store review comfort; add a mail provider before
  opening this up beyond your household.
- **No 2FA.**
- **No per-IP account lockout**, only rate limiting.

---

## 7. Operating it

Health check for a load balancer or uptime monitor:

```
GET /api/health   ->  200 {"ok":true,...}
```

Rotating the signing secret (signs everyone out, they just sign in again):

```bash
fly secrets set JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
```

---

## 8. Running the tests and audits

```bash
cd server

npm test                  # 57 tests
npm run verify-deployment -- --url https://your-host
npm run device-readiness  # static iOS audit
```

`npm test` covers:

- **API / security (28)** — invite single-use, token rotation and replay,
  cross-household isolation, admin-only actions, last-admin protection,
  account deletion, password change revoking other sessions, audit log,
  security headers.
- **Client ↔ server (12)** — the real `www/api.js` against the real server,
  including offline queueing and silent token refresh.
- **UI (11)** — the real `www/index.html` driven in JSDOM: sign-in, join with an
  invite, all seven views, adding an item that reaches the server, a second
  device seeing the shared list, delete-account control, and local-mode fallback.
- **HTTPS (6)** — the server on a real TLS listener with a generated
  self-signed certificate: plaintext refused on the TLS port, `Secure`+`HttpOnly`
  cookie in production mode, no-Origin (native WebView) accepted, unknown Origin
  not reflected, security headers, and the app signing in over TLS.

`npm run device-readiness` statically audits the iOS project: plist keys,
export compliance, build settings, privacy manifest registration, the 1024×1024
icon (including the PNG colour type, because Apple rejects an alpha channel),
whether the iOS bundle matches `www/`, and whether `FG_API_BASE` is set to an
HTTPS URL. It cannot compile or run anything — that needs macOS.

# Privacy model — a private, family-only app

This document states exactly who can get in, and what stops anyone else. Every
claim here is covered by an automated test in `server/test/privacy.test.js` and
`server/test/invite-ui.test.js`.

---

## The guarantee

> A person who has not been personally invited by the household owner cannot
> create an account, cannot read any data, and cannot discover who is in the
> household.

There is **no public sign-up**. There is no "guest" mode, no demo account, and no
shared link that grants access.

---

## Who can get in

Exactly three ways, and nothing else:

| # | Who | How |
|---|---|---|
| 1 | **You** (the owner) | One-time `SETUP_TOKEN` on a fresh server, creating the first account |
| 2 | **An invited family member** | An invite code you created in the app, plus a password they choose |
| 3 | **Nobody else** | — |

The app also has a **local mode** with no server, which stores everything on one
device and involves no accounts at all. It cannot see or touch shared data,
because there is no shared data. See "Local mode" below.

---

## The two gates

### Gate 1 — claiming the household (once, ever)

The very first account needs a `SETUP_TOKEN` you generate yourself. Compare it in
constant time.

**Why this exists.** The obvious alternative is to set `REQUIRE_INVITE=false`,
register, then set it back to `true`. That leaves a **race**: between the deploy
and the flip-back, anyone who finds your URL and posts to `/api/auth/register`
becomes the owner. On a freshly published URL, automated scanners find it within
minutes.

With `SETUP_TOKEN` the invite gate stays `true` **permanently** — there is no
window at all:

```bash
# generate once
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

# set on the server, and NEVER change it afterwards
SETUP_TOKEN=<that value>
REQUIRE_INVITE=true
```

The token stops mattering the moment the first account exists, so leaving it in
the environment is harmless.

If the server refuses your claim, `create-owner.js` tells you exactly which of
these two situations you are in.

### Gate 2 — joining the household (every account after the first)

Requires a valid invite code. Codes are:

- **Permanent by default** — no expiry unless you explicitly choose 7 or 30 days
- **12 characters** from a 32-symbol alphabet (no look-alikes like `I`/`1`) ≈ **60 bits** of entropy
- **Stored only as a SHA-256 hash** — the plaintext cannot be recovered from a database dump
- **Shown exactly once**, at creation
- **Single use** — redeemed atomically
- **Revocable** at any time before use
- **Optionally bound to one email address**, in which case no other address can redeem it

Rate-limited to 10 credential attempts per IP per 15 minutes, so codes cannot be
brute-forced even hypothetically.

> **Permanent ≠ reusable.** A permanent code still works for exactly one person,
> once. If it were multi-use, anyone it was forwarded to could join your
> household. Issue one code per family member — the app makes that one tap.

---

## Members stay signed in

Once a member joins, they do **not** have to sign in again.

| Piece | Lifetime | Why |
|---|---|---|
| Access token | 15 minutes | Never written to the device; silently renewed |
| Refresh token | **365 days, sliding** | Single-use, rotated on every use, expiry reset each time |

Because the refresh token's expiry is recalculated from the moment of each
refresh, a member who opens the app at least once a year **never sees the login
screen again**. Set `REFRESH_TOKEN_TTL_DAYS` up to `3650` if you would rather it
were ten years.

**The one honest limit:** this is a *sliding* window, not an eternal one. If a
phone sits unused and untouched for longer than the window (a year by default),
that member must enter their password once more. Nothing is lost — the data is
untouched — only the session. If that bothers you, raise the value to `3650`.

**Revocation always wins, whatever the window is set to.** Disabling a member
kills every one of their refresh tokens immediately; the cookie they hold is dead
on the very next request, and sign-in is refused.

---

## What each person can do

| Action | Member | Owner (admin) |
|---|---|---|
| See the shared list, items, history, stats | yes | yes |
| Add / edit / buy items | yes | yes |
| Invite new members | **no** | yes |
| Change roles, disable members | **no** | yes |
| Set the weekly budget | yes | yes |

A member cannot grow the roster. Only the owner can, and every invite is traceable
to them in the audit log.

**The owner cannot be locked out.** The last remaining admin cannot be deleted,
demoted, or disabled — the API refuses with `last_admin`. Promote someone else
first.

---

## Withdrawing access

**Disable** (العائلة → سحب وصول) — the immediate, reversible option:

- All refresh tokens revoked
- The existing access token stops working on the very next request
- Sign-in refused with `account_disabled`
- Their name is scrubbed from items they requested or bought
- Their items **stay** in the list, so your shopping history stays coherent

**Delete the account** (حسابي → حذف حسابي) — permanent, for yourself.

To remove a member entirely, disable them, then have them delete their own
account, or delete the row directly.

---

## What an outsider cannot learn

- **No account enumeration.** Registering with a known member's email and with a
  random email produce byte-identical responses. Earlier they did not: a `409
  "email taken"` versus `403 "invite required"` would have revealed exactly who
  is in your household. Fixed, and there is a test asserting the two responses
  match.
- **No login enumeration.** Unknown email and wrong password give the same status,
  the same error code and the same message.
- **No timing oracle on login.** A dummy scrypt hash is computed even when the
  account does not exist, so response time does not reveal whether an address is
  registered.
- **No invite-code recovery.** Only hashes are stored.
- **No plaintext codes in the invite list.** The app shows status and address,
  never the code.
- **Unauthenticated requests get `401`** on every data route, and the body leaks
  nothing.

---

## Data handling

- Stored in one SQLite file on **your** server. Apple never sees it.
- Passwords: **scrypt**, N=32768, r=8, p=1, 16-byte random salt each. Never
  stored or logged in plaintext.
- Access tokens: 15-minute signed JWTs, never persisted client-side.
- Refresh tokens: opaque, single-use, **rotated on every use**, stored hashed.
  A stolen database cannot be replayed.
- Transport: **HTTPS only in production.** iOS will refuse plaintext — the app
  ships no ATS exception, deliberately.
- Every sign-in, sign-up, password change, account deletion, invite
  creation/revocation, role change and access withdrawal is written to an
  `audit_log` with timestamp and IP.

---

## Local mode (no server)

If no server URL is configured, the app runs entirely on-device:

- No accounts, no passwords, pick a local profile
- Data lives in that browser/device's `localStorage` and **nowhere else**
- It **cannot** see your household's data — there is no connection
- Disabling this mode: clear the server URL (إعدادات الخادم) so the app only ever
  offers sign-in

Use it for a spare phone or a backup, not as a way to share the list.

---

## Deployment checklist for a private family app

```bash
NODE_ENV=production
SETUP_TOKEN=<generated once, never changed>
REQUIRE_INVITE=true          # permanently on
TRUST_PROXY=true             # behind TLS-terminating proxy
JWT_SECRET=<32+ random chars>
DATABASE_URL=/data/app.db    # on a persistent volume
CORS_ORIGINS=                # empty: only the packaged app talks to it
REFRESH_TOKEN_TTL_DAYS=365   # 3650 if you want a ten-year window
```

- [ ] HTTPS working, publicly trusted certificate
- [ ] `npm run verify-deployment -- --url https://…` — all pass
- [ ] `npm run create-owner -- --url https://… --email you@… --setup-token …`
- [ ] `REQUIRE_INVITE=true` **and** `SETUP_TOKEN` still set
- [ ] Sign in to the app as owner
- [ ] Disable a test member, confirm access ends immediately
- [ ] Database backed up (one file: `sqlite3 app.db ".backup 'backup.db'"`)

---

## Known limitations — read these

- **Long sessions are a real trade-off.** A member's device holds a refresh token
  valid for up to a year. If the phone is stolen, the thief has a year of access
  to the grocery list unless you disable the member. For a shopping list this is
  usually an acceptable trade for never being logged out; for anything more
  sensitive, lower `REFRESH_TOKEN_TTL_DAYS`.
- **No email verification.** An invite can be bound to an address, but the
  address is never confirmed. If someone forwards the code to their own address
  *and* the invite is unbound, they can join. **Always bind invites to an email**
  and send the code to that person directly.
- **No password reset.** An admin must remove and re-invite the member. For a
  family this is acceptable; it is not for a public sign-up.
- **No two-factor authentication.**
- **Rate limiting is per IP**, not per account.
- **Last-write-wins sync.** Two people editing the same item simultaneously: the
  later write wins. Fine for a shopping list.
- **The owner is a single point of failure.** If you lose the account, the
  household cannot be administered — there is no recovery flow. Promote a second
  admin.
- **Your hosting provider holds the database at rest** (encrypted disk). Pick one
  you trust with family data.

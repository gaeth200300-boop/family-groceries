# Family Groceries — server

Invite-only backend for the Family Groceries iOS app. Node + Express + SQLite,
no build step and no native dependencies.

## Quick start

```bash
cp .env.example .env
# set JWT_SECRET to 32+ random characters
npm install
npm start          # app + API at http://localhost:8787
npm test           # 98 tests
```

`npm start` serves both the API and `../www` on one origin, which is what makes
the PWA installable and Web Push possible. For phone access over HTTPS run
`MOBILE-LINK.cmd` from the project root (Cloudflare Quick Tunnel), then enable
notifications from the dashboard. VAPID keys are generated on first use into
`data/vapid.json` unless you set them in `.env`.

The first account to register becomes the household owner. Set
`REQUIRE_INVITE=true` (the default) immediately afterwards.

Full deployment instructions: [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md)

## API

All routes are prefixed `/api`. Authenticated routes need
`Authorization: Bearer <accessToken>`.

### Auth

| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/register` | Invite-only. First signup bootstraps a household when `REQUIRE_INVITE=false`. |
| `POST` | `/auth/login` | Returns an access token + sets an httpOnly refresh cookie. |
| `POST` | `/auth/refresh` | Rotates the refresh token; the old one becomes unusable. |
| `POST` | `/auth/logout` | Revokes the refresh token. |
| `GET` | `/auth/me` | Current user + household. |
| `POST` | `/auth/change-password` | Requires the current password; revokes all other sessions. |
| `DELETE` | `/auth/account` | **Account deletion** (App Review 5.1.1(v)). |

### Household (admin-only where noted)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/household/invites` | admin — mints a code, returned **once**. |
| `GET` | `/auth/household/invites` | admin — statuses only, never codes. |
| `DELETE` | `/auth/household/invites/:id` | admin — revokes an unused invite. |
| `GET` | `/auth/household/members` | any member |
| `POST` | `/auth/household/members/:id/disable` | admin — revokes access immediately. |
| `POST` | `/auth/household/members/:id/enable` | admin |
| `POST` | `/auth/household/members/:id/role` | admin — cannot demote the last admin. |

### Grocery data

| Method | Path | Notes |
|---|---|---|
| `GET` | `/lists/state` | Whole household state in one call. |
| `POST` | `/lists` | One active list per household. |
| `POST` | `/lists/finish` | Archives the week, bumps the number, optional carry-over. |
| `PATCH` | `/lists/:id` | |
| `POST` | `/lists/:id/items` | |
| `PATCH` | `/items/:id` | `purchased: true` defaults `actualPrice` to `price`. |
| `DELETE` | `/items/:id` | |
| `POST` | `/notifications/read` | |

## Design notes

- **Tenancy is the security boundary.** The household id comes from the signed
  token, never from the request. Every query filters on it, so cross-household
  access returns 404 rather than data. Tested explicitly.
- **scrypt over argon2/bcrypt.** Both need native compilation, which is a common
  source of deployment failure. `node:crypto`'s scrypt at N=32768 is memory-hard
  and dependency-free.
- **`node:sqlite`** is Node's built-in driver — no `better-sqlite3` build step.
- **Refresh tokens are opaque and stored hashed**, so a database leak cannot be
  replayed. They rotate on every use, making theft detectable and short-lived.
- **Last-write-wins.** Deliberate for a shopping list; not suitable for
  simultaneous collaborative editing.

## Known gaps

- No email verification or password reset (an admin must re-invite).
- No 2FA.
- No push notifications; the client polls on open.
- Images stored inline as base64, 3 MB request cap.

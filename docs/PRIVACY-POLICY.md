# Privacy Policy — مقاضي العائلة (Family Groceries)

**Last updated:** 27 September 2026

This policy explains what the Family Groceries app ("the app") collects, why, and
what control you have. It is written to be readable; if anything here is unclear,
contact the developer using the details in the App Store listing.

---

## The short version

- The app is for a **private group of people** — typically one household.
- Access is by **invitation only**. You cannot create an account without an
  invite code issued by the household administrator.
- Your shopping lists are stored on the **developer's own server** so the people
  you invited can see them. That is the entire point of the app.
- The developer **cannot see your list contents in a browsing interface** — the
  data is only accessible to members of your own household through the app.
- Nothing is collected for advertising or tracking. Nothing is sold or shared
  with third parties for marketing. Apple is not given any of your data.

---

## What is collected

When you create an account, the app sends the following to the server:

| Data | Why |
|---|---|
| Email address | It is your sign-in identity, and it is what an invite code can be bound to. |
| Display name | Shown to the other members of your household. |
| Password | Stored only as a salted **scrypt** hash. The plain password is never stored or logged. |

When you use the app, the following is stored so your household can share it:

- Grocery items: name, quantity, unit, expected price, actual price, store,
  category, notes
- Purchase status, and which member marked it bought
- Receipt and product photos you choose to attach
- Weekly shopping lists, budgets and archived history
- An activity feed (who added or bought what) visible to your household
- Technical logs: sign-in, sign-up, password change, account deletion, invite
  creation and permission changes, with IP address and timestamp

## What is NOT collected

- No advertising or analytics SDKs
- No location data
- No contacts, photos library, or microphone access
- No data sold, rented or shared with advertisers or data brokers
- No cross-app or cross-site tracking; no tracking identifier of any kind

## Third parties

| Party | Role |
|---|---|
| Your hosting provider | Hosts the server and therefore holds the database at rest. |
| Apple | Distributes the app. Receives only the data you type into App Store Connect. |
| Google Fonts, jsDelivr | The app loads web fonts and two chart libraries from these CDNs. **Your IP address is visible to them** when the app opens. These are not used for tracking. |

The Google Fonts / jsDelivr dependency is a privacy consideration worth naming
explicitly. Bundling those assets locally in a future release would remove it.

---

## How your data is protected

- Passwords are hashed with **scrypt** (N=32768) using a unique random salt each.
- Sessions use short-lived tokens (15 minutes) plus a rotating, single-use
  refresh token.
- All data access is restricted to members of your own household. It is
  technically impossible for one household to read another's data through the
  API; this is covered by automated tests.
- Data is held in an encrypted database on a server reachable only over HTTPS.
- Access can be withdrawn at any time by the administrator, which immediately
  revokes that person's session.
- There is no administrator interface that lists your shopping list contents.

---

## Your rights and controls

**Delete your account — inside the app.** Sign in, open account settings, and
choose "Delete account". This permanently removes your account and revokes your
sessions. Your name is removed from items you added or purchased; those items
remain in your household's list so the shopping history stays coherent.

**Leave a household.** Ask the administrator to disable your account. Your
account is disabled and your access ends immediately, though your history stays
with the household.

**Withdraw an invite.** Administrators can revoke any unused invite code at any
time. Used codes cannot be revoked — delete the account instead.

**Access your data.** All your household's data is visible in the app itself.
There is no separate export.

**Contact.** Use the support URL in the App Store listing.

---

## Children

The app is not directed at children under 13 and is not intended for their use.
Because accounts are created only by household invitation, the operator is
responsible for ensuring anyone invited is old enough to hold an account in
their jurisdiction.

---

## International transfers

The server is hosted in a single region chosen by the developer. If you are in
another country, your household data is transferred to that region to provide
the service. No other international transfers occur.

---

## Changes

Material changes to this policy will be reflected in the updated date above and,
where the App Store permits, noted in the app's release notes. Continued use after
a change means you accept it.

---

## Contact

Developer: _[name]_
Email: _[email]_
Website: _[support URL]_

> Replace every bracketed placeholder before submitting. Apple requires a working
> support URL and a reachable contact address.

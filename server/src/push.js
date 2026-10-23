import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { config } from "./config.js";
import { getDb, newId, now } from "./db.js";

/**
 * Web Push for the household.
 *
 * There is no third-party account and no Firebase project: the server signs
 * notifications with a VAPID key pair. On first boot the pair is generated and
 * written next to the SQLite database (server/data/vapid.json), which is
 * git-ignored. Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to share one identity
 * across several replicas.
 */

let cachedKeys = null;
let configured = false;

export function vapidKeys() {
  if (cachedKeys) return cachedKeys;

  if (config.vapidPublicKey && config.vapidPrivateKey) {
    cachedKeys = { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey };
    return cachedKeys;
  }

  // Tests use an in-memory database; keep the generated key in that process.
  if (config.databasePath === ":memory:") {
    cachedKeys = webpush.generateVAPIDKeys();
    return cachedKeys;
  }

  const dir = path.dirname(path.resolve(config.databasePath));
  const file = path.join(dir, "vapid.json");

  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed.publicKey && parsed.privateKey) {
        cachedKeys = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
        return cachedKeys;
      }
    }
  } catch {
    // A corrupt key file is replaced below; existing subscriptions will need
    // to re-subscribe, which the client does the next time push is enabled.
  }

  cachedKeys = webpush.generateVAPIDKeys();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cachedKeys, null, 2), { mode: 0o600 });
  return cachedKeys;
}

export function publicKey() {
  return vapidKeys().publicKey;
}

function configure() {
  if (configured) return;
  const keys = vapidKeys();
  webpush.setVapidDetails(config.vapidSubject, keys.publicKey, keys.privateKey);
  configured = true;
}

const shapeSubscription = (row) => ({
  endpoint: row.endpoint,
  keys: { p256dh: row.p256dh, auth: row.auth },
});

async function sendRows(rows, payload) {
  if (!rows.length) return { sent: 0, pruned: 0 };

  // Automated tests must never wait on a real push-service round trip. The
  // subscription CRUD is still exercised; delivery is verified on a device.
  if (config.env === "test") return { sent: 0, pruned: 0, skipped: true };

  configure();
  const d = getDb();
  const body = JSON.stringify(payload);
  let sent = 0;
  let pruned = 0;

  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(shapeSubscription(row), body, { TTL: 3600 });
        sent += 1;
        d.prepare("UPDATE push_subscriptions SET last_success_at = ? WHERE id = ?").run(now(), row.id);
      } catch (err) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          // The browser dropped this subscription (app removed / permission reset).
          d.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(row.id);
          pruned += 1;
        } else {
          console.warn("[push] delivery failed:", status || err?.message || err);
        }
      }
    }),
  );

  return { sent, pruned };
}

/**
 * Sends to every subscribed device in a household.
 * `excludeUserId` skips the member who performed the action so they do not get
 * a notification about their own tap (unless the caller wants a copy).
 */
export async function sendToHousehold(householdId, payload, { excludeUserId = null } = {}) {
  const d = getDb();
  const rows = d
    .prepare("SELECT * FROM push_subscriptions WHERE household_id = ?")
    .all(householdId)
    .filter((row) => !excludeUserId || row.user_id !== excludeUserId);
  return sendRows(rows, payload);
}

export async function sendToUser(householdId, userId, payload) {
  const d = getDb();
  const rows = d
    .prepare("SELECT * FROM push_subscriptions WHERE household_id = ? AND user_id = ?")
    .all(householdId, userId);
  return sendRows(rows, payload);
}

/** Stores or refreshes a subscription. An endpoint belongs to one device. */
export function saveSubscription({ householdId, userId, endpoint, p256dh, auth, userAgent }) {
  const d = getDb();
  const existing = d.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?").get(endpoint);
  if (existing) {
    d.prepare(
      `UPDATE push_subscriptions
          SET household_id = ?, user_id = ?, p256dh = ?, auth = ?, user_agent = ?
        WHERE id = ?`,
    ).run(householdId, userId, p256dh, auth, userAgent ?? null, existing.id);
    return existing.id;
  }

  const id = newId("ps");
  d.prepare(
    `INSERT INTO push_subscriptions
       (id, household_id, user_id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, householdId, userId, endpoint, p256dh, auth, userAgent ?? null, now());
  return id;
}

export function removeSubscription({ householdId, userId, endpoint }) {
  const r = getDb()
    .prepare("DELETE FROM push_subscriptions WHERE household_id = ? AND user_id = ? AND endpoint = ?")
    .run(householdId, userId, endpoint);
  return r.changes > 0;
}

export function countSubscriptions(householdId, userId) {
  return getDb()
    .prepare("SELECT COUNT(*) AS c FROM push_subscriptions WHERE household_id = ? AND user_id = ?")
    .get(householdId, userId).c;
}

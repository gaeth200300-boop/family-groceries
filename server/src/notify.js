import { addNotification } from "./db.js";
import { sendToHousehold } from "./push.js";
import { config } from "./config.js";

/**
 * Writes an in-app notification for the whole household and (unless disabled)
 * pushes it to phones that subscribed. Both sides are fire-and-forget: a slow
 * push service must never block or fail the request that caused the event.
 *
 * `includeActor` is true for a new request so the person who added the item
 * also gets the confirmation on their own phone, which is what makes "I asked
 * for something and a message arrived" work even when they are the only one
 * testing the app.
 */
export function notifyHousehold(req, { type, text, push = true, includeActor = false, title = "مقاضي العائلة" }) {
  addNotification(req.householdId, { type, text });

  if (!push) return;
  sendToHousehold(
    req.householdId,
    { title, body: text, url: "/", tag: `${type}-${Date.now()}` },
    { excludeUserId: includeActor ? null : req.user.id },
  ).catch((err) => {
    // Delivery failures are logged by push.js; this guards against anything
    // unexpected (e.g. a malformed subscription row) reaching the route.
    if (config.env !== "test") console.warn("[notify] push error:", err?.message || err);
  });
}

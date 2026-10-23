import express from "express";
import { z } from "zod";
import { requireAuth, wrap, badRequest } from "../auth.js";
import {
  countSubscriptions,
  publicKey,
  removeSubscription,
  saveSubscription,
  sendToUser,
} from "../push.js";

export const pushRouter = express.Router();
pushRouter.use(requireAuth);

/** The VAPID public key the browser needs before subscribing. */
pushRouter.get(
  "/push/key",
  wrap(async (_req, res) => {
    res.json({ enabled: true, publicKey: publicKey() });
  }),
);

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2048),
  expirationTime: z.number().nullable().optional(),
  keys: z
    .object({
      p256dh: z.string().min(1).max(512),
      auth: z.string().min(1).max(512),
    })
    .optional(),
  // Accepted as a fallback for older clients that flattened the keys.
  p256dh: z.string().min(1).max(512).optional(),
  auth: z.string().min(1).max(512).optional(),
});

pushRouter.post(
  "/push/subscribe",
  wrap(async (req, res) => {
    const body = subscribeSchema.parse(req.body ?? {});
    const p256dh = body.keys?.p256dh ?? body.p256dh;
    const auth = body.keys?.auth ?? body.auth;
    if (!p256dh || !auth) {
      throw badRequest("Subscription keys are required", "push_keys_required");
    }

    saveSubscription({
      householdId: req.householdId,
      userId: req.user.id,
      endpoint: body.endpoint,
      p256dh,
      auth,
      userAgent: (req.get("user-agent") || "").slice(0, 300),
    });

    res.status(201).json({
      ok: true,
      subscriptions: countSubscriptions(req.householdId, req.user.id),
    });
  }),
);

pushRouter.post(
  "/push/unsubscribe",
  wrap(async (req, res) => {
    const { endpoint } = z
      .object({ endpoint: z.string().min(1).max(2048) })
      .parse(req.body ?? {});
    const removed = removeSubscription({
      householdId: req.householdId,
      userId: req.user.id,
      endpoint,
    });
    res.json({ ok: true, removed });
  }),
);

/** Sends a real notification to the caller's own devices, used by the UI test button. */
pushRouter.post(
  "/push/test",
  wrap(async (req, res) => {
    const subscriptions = countSubscriptions(req.householdId, req.user.id);
    const result = await sendToUser(req.householdId, req.user.id, {
      title: "مقاضي العائلة",
      body: "تم تفعيل إشعارات الجوال بنجاح — هذا تنبيه تجريبي.",
      url: "/",
      tag: "test",
    });
    res.json({ ok: true, subscriptions, ...result });
  }),
);

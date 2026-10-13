import express from "express";
import { z } from "zod";
import { getDb, newId, now, audit } from "../db.js";
import { requireAuth, wrap, badRequest, notFound } from "../auth.js";

export const listsRouter = express.Router();
listsRouter.use(requireAuth);

const CATEGORIES = ["dairy", "meat", "veg", "fruit", "pantry", "drinks", "clean", "sweets", "care", "other"];
const UNITS = ["قطعة", "عبوة", "كجم", "لتر", "علبة", "كيس", "حبة"];

const itemInput = z.object({
  name: z.string().min(1).max(120),
  qty: z.coerce.number().positive().max(9999).default(1),
  unit: z.string().max(24).default("قطعة"),
  price: z.coerce.number().min(0).max(9_999_999).default(0),
  actualPrice: z.coerce.number().min(0).max(9_999_999).nullable().optional(),
  store: z.string().max(120).default(""),
  category: z.enum(CATEGORIES).default("other"),
  note: z.string().max(500).default(""),
  image: z.string().max(2_600_000).nullable().optional(), // base64 data URL from the client
  purchased: z.boolean().default(false),
});

function shapeItem(r) {
  return {
    id: r.id,
    listId: r.list_id,
    name: r.name,
    qty: r.qty,
    unit: r.unit,
    price: r.price,
    actualPrice: r.actual_price,
    store: r.store,
    cat: r.category,
    by: r.requested_by,
    note: r.note,
    image: r.image,
    purchased: !!r.purchased,
    purchasedBy: r.purchased_by,
    purchasedAt: r.purchased_at,
  };
}

function shapeList(d, listRow) {
  const rows = d.prepare(`SELECT * FROM items WHERE list_id = ? ORDER BY created_at ASC`).all(listRow.id);
  return {
    id: listRow.id,
    name: listRow.name,
    week: listRow.week,
    status: listRow.status,
    store: listRow.store,
    shopper: listRow.shopper_id,
    createdAt: listRow.created_at,
    endedAt: listRow.ended_at,
    receiptTotal: listRow.receipt_total,
    image: listRow.image,
    items: rows.map(shapeItem),
  };
}

/* --------------------------------------------------------------- read all */

/**
 * GET /api/lists/state
 * One call returns everything the app needs, mirroring the shape the client
 * previously kept in localStorage.
 */
listsRouter.get(
  "/lists/state",
  wrap(async (req, res) => {
    const d = getDb();
    const lists = d
      .prepare(`SELECT * FROM lists WHERE household_id = ? ORDER BY week ASC, created_at ASC`)
      .all(req.householdId);
    const active = lists.find((l) => l.status === "active") ?? null;
    const notifications = d
      .prepare(
        `SELECT * FROM notifications WHERE household_id = ? AND (user_id IS NULL OR user_id = ?)
         ORDER BY ts DESC LIMIT 60`,
      )
      .all(req.householdId, req.user.id);
    res.json({
      householdId: req.householdId,
      budget: d.prepare(`SELECT budget FROM households WHERE id = ?`).get(req.householdId)?.budget ?? 0,
      week: active?.week ?? 0,
      currentList: active ? shapeList(d, active) : null,
      archived: lists.filter((l) => l.status === "archived").map((l) => shapeList(d, l)),
      notifications: notifications.map((n) => ({
        id: n.id, type: n.type, text: n.text, ts: n.ts, read: !!n.read_at,
      })),
      serverTime: now(),
    });
  }),
);

/* ----------------------------------------------------------- household */

/** Budget lives on the household, not the list. */
listsRouter.patch(
  "/household",
  wrap(async (req, res) => {
    const body = z
      .object({ budget: z.coerce.number().min(0).max(9_999_999) })
      .parse(req.body ?? {});
    getDb()
      .prepare(`UPDATE households SET budget = ? WHERE id = ?`)
      .run(body.budget, req.householdId);
    audit(req.householdId, req.user.id, "household.budget.updated", String(body.budget), req.ip);
    res.json({ ok: true, budget: body.budget });
  }),
);

/**
 * A brand-new household has no list, which would leave the app with nothing to
 * render. This creates the opening week on demand.
 */
listsRouter.post(
  "/lists/bootstrap",
  wrap(async (req, res) => {
    const d = getDb();
    const existing = d
      .prepare(`SELECT id FROM lists WHERE household_id = ? AND status = 'active'`)
      .get(req.householdId);
    if (existing) throw badRequest("This household already has an active list", "list_exists");

    const budget = z.coerce.number().min(0).max(9_999_999).catch(600).parse(req.body?.budget);
    const week = z.coerce.number().int().min(1).max(9999).catch(1).parse(req.body?.week);

    const id = newId("l");
    d.prepare(`INSERT INTO lists (id, household_id, name, week, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`)
      .run(id, req.householdId, `الأسبوع ${week}`, week, now());
    d.prepare(`UPDATE households SET budget = ? WHERE id = ?`).run(budget, req.householdId);
    audit(req.householdId, req.user.id, "list.bootstrapped", id, req.ip);

    res.status(201).json(shapeList(d, d.prepare(`SELECT * FROM lists WHERE id = ?`).get(id)));
  }),
);

/* ----------------------------------------------------------------- lists */

const createListSchema = z.object({
  name: z.string().min(1).max(80),
  week: z.coerce.number().int().min(1).max(9999),
  budget: z.coerce.number().min(0).max(9_999_999).optional(),
});

listsRouter.post(
  "/lists",
  wrap(async (req, res) => {
    const body = createListSchema.parse(req.body);
    const d = getDb();
    const existing = d
      .prepare(`SELECT id FROM lists WHERE household_id = ? AND status = 'active'`)
      .get(req.householdId);
    if (existing) throw badRequest("This household already has an active list", "list_exists");

    const id = newId("l");
    d.prepare(
      `INSERT INTO lists (id, household_id, name, week, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
    ).run(id, req.householdId, body.name, body.week, now());
    if (body.budget != null) {
      d.prepare(`UPDATE households SET budget = ? WHERE id = ?`).run(body.budget, req.householdId);
    }
    audit(req.householdId, req.user.id, "list.created", id, req.ip);
    res.status(201).json(shapeList(d, d.prepare(`SELECT * FROM lists WHERE id = ?`).get(id)));
  }),
);

/** Close the active list and optionally carry unpurchased items into a new week. */
const finishSchema = z.object({
  receiptTotal: z.coerce.number().min(0).max(9_999_999).optional(),
  store: z.string().max(120).optional(),
  shopperId: z.string().max(64).optional(),
  endedAt: z.coerce.number().int().positive().optional(),
  carryOver: z.boolean().default(false),
  image: z.string().max(2_600_000).nullable().optional(),
});

listsRouter.post(
  "/lists/finish",
  wrap(async (req, res) => {
    const body = finishSchema.parse(req.body);
    const d = getDb();
    const active = d
      .prepare(`SELECT * FROM lists WHERE household_id = ? AND status = 'active'`)
      .get(req.householdId);
    if (!active) throw notFound("No active list");

    const items = d.prepare(`SELECT * FROM items WHERE list_id = ?`).all(active.id);
    if (!items.some((i) => i.purchased)) {
      throw badRequest("Mark at least one item as purchased before finishing", "nothing_purchased");
    }

    const endedAt = body.endedAt ?? now();
    const actual = items.reduce((s, i) => s + (i.purchased ? Number(i.actual_price ?? i.price ?? 0) : 0), 0);

    d.exec("BEGIN");
    try {
      d.prepare(
        `UPDATE lists SET status='archived', ended_at=?, receipt_total=?, store=?, shopper_id=?, image=?
         WHERE id = ?`,
      ).run(endedAt, body.receiptTotal ?? actual, body.store ?? null, body.shopperId ?? null,
        body.image ?? null, active.id);

      const newId_ = newId("l");
      d.prepare(
        `INSERT INTO lists (id, household_id, name, week, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
      ).run(newId_, req.householdId, `الأسبوع ${active.week + 1}`, active.week + 1, now());

      if (body.carryOver) {
        const ins = d.prepare(
          `INSERT INTO items (id, household_id, list_id, name, qty, unit, price, store, category,
             requested_by, note, image, purchased, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        );
        for (const i of items.filter((x) => !x.purchased)) {
          ins.run(newId("it"), req.householdId, newId_, i.name, i.qty, i.unit, i.price,
            i.store, i.category, req.user.id, i.note, i.image, now());
        }
      }
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }

    audit(req.householdId, req.user.id, "list.finished", active.id, req.ip);
    res.json({ ok: true, archivedId: active.id, newWeek: active.week + 1 });
  }),
);

listsRouter.patch(
  "/lists/:id",
  wrap(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        store: z.string().max(120).nullable().optional(),
        receiptTotal: z.coerce.number().min(0).max(9_999_999).nullable().optional(),
        image: z.string().max(2_600_000).nullable().optional(),
      })
      .parse(req.body ?? {});
    const d = getDb();
    const list = d
      .prepare(`SELECT * FROM lists WHERE id = ? AND household_id = ?`)
      .get(req.params.id, req.householdId);
    if (!list) throw notFound("List not found");

    const sets = [];
    const vals = [];
    if (body.name !== undefined) { sets.push("name = ?"); vals.push(body.name); }
    if (body.store !== undefined) { sets.push("store = ?"); vals.push(body.store); }
    if (body.receiptTotal !== undefined) { sets.push("receipt_total = ?"); vals.push(body.receiptTotal); }
    if (body.image !== undefined) { sets.push("image = ?"); vals.push(body.image); }
    if (sets.length) {
      d.prepare(`UPDATE lists SET ${sets.join(", ")} WHERE id = ? AND household_id = ?`)
        .run(...vals, list.id, req.householdId);
    }
    res.json(shapeList(d, d.prepare(`SELECT * FROM lists WHERE id = ?`).get(list.id)));
  }),
);

/* ----------------------------------------------------------------- items */

listsRouter.post(
  "/lists/:id/items",
  wrap(async (req, res) => {
    const body = itemInput.parse(req.body);
    const d = getDb();
    const list = d
      .prepare(`SELECT * FROM lists WHERE id = ? AND household_id = ?`)
      .get(req.params.id, req.householdId);
    if (!list) throw notFound("List not found");

    const id = newId("it");
    d.prepare(
      `INSERT INTO items (id, household_id, list_id, name, qty, unit, price, actual_price, store,
         category, requested_by, note, image, purchased, purchased_by, purchased_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, req.householdId, list.id, body.name.trim(), body.qty, body.unit, body.price,
      body.purchased ? (body.actualPrice ?? body.price) : null, body.store, body.category,
      req.user.id, body.note, body.image ?? null, body.purchased ? 1 : 0,
      body.purchased ? req.user.id : null, body.purchased ? now() : null, now());

    audit(req.householdId, req.user.id, "item.added", id, req.ip);
    res.status(201).json(shapeItem(d.prepare(`SELECT * FROM items WHERE id = ?`).get(id)));
  }),
);

listsRouter.patch(
  "/items/:id",
  wrap(async (req, res) => {
    const body = itemInput.partial().parse(req.body);
    const d = getDb();
    const existing = d
      .prepare(`SELECT * FROM items WHERE id = ? AND household_id = ?`)
      .get(req.params.id, req.householdId);
    if (!existing) throw notFound("Item not found");

    const map = {
      name: "name", qty: "qty", unit: "unit", price: "price", actualPrice: "actual_price",
      store: "store", category: "category", note: "note", image: "image",
    };
    const sets = [];
    const vals = [];
    for (const [k, col] of Object.entries(map)) {
      if (body[k] !== undefined) { sets.push(`${col} = ?`); vals.push(body[k]); }
    }
    if (body.purchased !== undefined) {
      sets.push("purchased = ?", "purchased_by = ?", "purchased_at = ?");
      if (body.purchased) {
        vals.push(1, req.user.id, now());
        // Marking purchased without an explicit price defaults to the expected price.
        if (body.actualPrice === undefined && existing.actual_price == null) {
          sets.push("actual_price = ?");
          vals.push(existing.price);
        }
      } else {
        // Un-purchasing resets the recorded spend, matching the client's behaviour.
        // Value order must match `sets`: purchased, purchased_by, purchased_at, actual_price.
        sets.push("actual_price = ?");
        vals.push(0, null, null, null);
      }
    }
    if (sets.length) {
      d.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ? AND household_id = ?`)
        .run(...vals, existing.id, req.householdId);
    }
    audit(req.householdId, req.user.id, "item.updated", existing.id, req.ip);
    res.json(shapeItem(d.prepare(`SELECT * FROM items WHERE id = ?`).get(existing.id)));
  }),
);

listsRouter.delete(
  "/items/:id",
  wrap(async (req, res) => {
    const d = getDb();
    const r = d
      .prepare(`DELETE FROM items WHERE id = ? AND household_id = ?`)
      .run(req.params.id, req.householdId);
    if (!r.changes) throw notFound("Item not found");
    audit(req.householdId, req.user.id, "item.deleted", req.params.id, req.ip);
    res.json({ ok: true });
  }),
);

/* ----------------------------------------------------------- notifications */

listsRouter.post(
  "/notifications/read",
  wrap(async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.string().max(64)).max(200).optional() })
      .parse(req.body ?? {});
    const d = getDb();
    const before = d.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE household_id = ? AND (user_id IS NULL OR user_id = ?) AND read_at IS NULL`)
      .get(req.householdId, req.user.id).c;
    if (ids?.length) {
      const stmt = d.prepare(
        `UPDATE notifications SET read_at = ? WHERE household_id = ? AND read_at IS NULL
         AND id IN (${ids.map(() => "?").join(",")})`,
      );
      stmt.run(now(), req.householdId, ...ids);
    } else {
      d.prepare(
        `UPDATE notifications SET read_at = ? WHERE household_id = ? AND read_at IS NULL AND (user_id IS NULL OR user_id = ?)`,
      ).run(now(), req.householdId, req.user.id);
    }
    res.json({ ok: true, cleared: before });
  }),
);

export { CATEGORIES, UNITS };

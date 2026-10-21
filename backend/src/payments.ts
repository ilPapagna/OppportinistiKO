import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { z } from "zod";
import { config } from "./config.js";
import { tx, one, pool } from "./db.js";
import { key, requireRole } from "./auth.js";
import { HttpError } from "./security.js";
import { moveCredits } from "./credits.js";
export const PACKS: Record<number, number> = {
  15: 1500,
  30: 2800,
  50: 4500,
  100: 8500,
};
export async function applyPaidSession(session: Stripe.Checkout.Session) {
  if (session.payment_status !== "paid" || session.mode !== "payment") return;
  const orderId = session.metadata?.orderId;
  if (!orderId) throw new Error("Missing checkout reference");
  await tx(async (db) => {
    const order = await one(
      db,
      "SELECT * FROM checkout_orders WHERE id=$1 FOR UPDATE",
      [orderId],
    );
    if (
      !order ||
      order.amount_cents !== session.amount_total ||
      order.currency !== session.currency ||
      session.metadata?.userId !== order.user_id
    )
      throw new Error("Checkout amount or owner mismatch");
    if (order.stripe_session_id && order.stripe_session_id !== session.id)
      throw new Error("Checkout session mismatch");
    if (order.credited) return;
    await moveCredits(
      db,
      order.user_id,
      order.credits,
      "TOPUP",
      order.id,
      `stripe:${session.id}`,
    );
    await db.query(
      "UPDATE checkout_orders SET credited=true,stripe_session_id=$2 WHERE id=$1",
      [orderId, session.id],
    );
  });
}
export async function paymentRoutes(app: FastifyInstance) {
  const stripe = config.STRIPE_SECRET_KEY
    ? new Stripe(config.STRIPE_SECRET_KEY, {
        maxNetworkRetries: 2,
        timeout: 15000,
      })
    : null;
  app.post("/api/v1/checkout", async (request) => {
    requireRole(request, "STUDENT");
    if (!stripe) throw new HttpError(503, "Pagamenti non configurati");
    const body = z
      .object({
        credits: z.union([
          z.literal(15),
          z.literal(30),
          z.literal(50),
          z.literal(100),
        ]),
      })
      .parse(request.body);
    const idem = key(request);
    const order = await tx(async (db) => {
      await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        request.actor.id,
      ]);
      const previous = await one(
        db,
        "SELECT * FROM checkout_orders WHERE user_id=$1 AND idempotency_key=$2",
        [request.actor.id, idem],
      );
      if (previous) {
        if (previous.credits !== body.credits)
          throw new HttpError(409, "Chiave già utilizzata");
        return previous;
      }
      return (await one(
        db,
        "INSERT INTO checkout_orders(user_id,credits,amount_cents,idempotency_key) VALUES($1,$2,$3,$4) RETURNING *",
        [request.actor.id, body.credits, PACKS[body.credits], idem],
      ))!;
    });
    if (order.credited) throw new HttpError(409, "Ricarica già completata");
    if (new Date(order.created_at).getTime() < Date.now() - 23 * 3600_000)
      throw new HttpError(409, "Checkout scaduto: avvia una nuova ricarica");
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        client_reference_id: order.id,
        metadata: { orderId: order.id, userId: request.actor.id },
        line_items: [
          {
            price_data: {
              currency: "eur",
              unit_amount: order.amount_cents,
              product_data: { name: `Radice · ${body.credits} crediti` },
            },
            quantity: 1,
          },
        ],
        success_url: `${config.APP_ORIGIN}/?checkout=success#shop`,
        cancel_url: `${config.APP_ORIGIN}/?checkout=cancelled#shop`,
      },
      { idempotencyKey: `radice-checkout-${order.id}` },
    );
    await pool.query(
      "UPDATE checkout_orders SET stripe_session_id=$2 WHERE id=$1",
      [order.id, session.id],
    );
    return { checkoutUrl: session.url };
  });
  app.post(
    "/api/v1/webhooks/stripe",
    {
      config: {
        public: true,
        webhook: true,
        rawBody: true,
        rateLimit: { max: 1000, timeWindow: "1 minute" },
      },
    },
    async (request) => {
      if (!stripe || !config.STRIPE_WEBHOOK_SECRET)
        throw new HttpError(503, "Stripe non configurato");
      const signature = request.headers["stripe-signature"];
      if (typeof signature !== "string" || typeof request.rawBody !== "string")
        throw new HttpError(400, "Firma mancante");
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(
          request.rawBody,
          signature,
          config.STRIPE_WEBHOOK_SECRET,
        );
      } catch {
        throw new HttpError(400, "Firma non valida");
      }
      if (
        event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded"
      )
        await applyPaidSession(event.data.object);
      return { received: true };
    },
  );
}

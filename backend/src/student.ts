import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { one, pool, tx } from "./db.js";
import { requireRole, uid, key, LEGAL_VERSION } from "./auth.js";
import { moveCredits } from "./credits.js";
import { enqueue } from "./jobs.js";
import { HttpError, isMinor } from "./security.js";
import { putImage, validateImage, signed, remove } from "./storage.js";
import { config } from "./config.js";
const reviewSQL = `SELECT r.id,r.subject,r.topic,r.study_date AS date,json_agg(s.done ORDER BY s.step) AS done,json_agg(s.due_date ORDER BY s.step) AS dates FROM reviews r JOIN review_steps s ON s.review_id=r.id WHERE r.user_id=$1 GROUP BY r.id ORDER BY r.created_at DESC,r.id DESC LIMIT 50`;
const bookingSQL = `SELECT b.id,b.status,b.join_url AS "joinUrl",t.first_name||' '||t.last_name AS tutor,to_char(s.starts_at AT TIME ZONE 'Europe/Rome','YYYY-MM-DD') AS date,to_char(s.starts_at AT TIME ZONE 'Europe/Rome','HH24:MI') AS time FROM bookings b JOIN tutor_slots s ON s.id=b.slot_id JOIN users t ON t.id=s.tutor_id WHERE b.student_id=$1 ORDER BY s.starts_at DESC LIMIT 50`;
async function associations(userId: string) {
  const result = await pool.query(
    "SELECT id,number,word,image_key FROM associations WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50",
    [userId],
  );
  return Promise.all(
    result.rows.map(async (a) => ({
      id: a.id,
      number: a.number,
      word: a.word,
      image: a.image_key ? await signed(a.image_key) : null,
    })),
  );
}
export async function studentRoutes(app: FastifyInstance) {
  app.get("/api/v1/me/dashboard", async (request) => {
    const id = request.actor.id;
    const [wallet, reviews, images, bookings, orders, calls] =
      await Promise.all([
        one(pool, "SELECT balance FROM wallets WHERE user_id=$1", [id]),
        pool.query(reviewSQL, [id]),
        associations(id),
        pool.query(bookingSQL, [id]),
        pool.query(
          "SELECT o.id,o.product,l.title AS topic FROM orders o JOIN lessons l ON l.id=o.lesson_id WHERE o.user_id=$1 ORDER BY o.created_at DESC LIMIT 50",
          [id],
        ),
        one(
          pool,
          "SELECT count(*)::int AS count FROM call_entitlements WHERE user_id=$1 AND NOT consumed",
          [id],
        ),
      ]);
    return {
      balance: wallet?.balance || 0,
      reviews: reviews.rows,
      associations: images,
      bookings: bookings.rows,
      purchases: orders.rows,
      calls: calls?.count || 0,
      unlocked: [],
      pageSize: 50,
    };
  });
  app.get("/api/v1/me/credits", async (request) => {
    const query = z
      .object({ before: z.iso.datetime().optional() })
      .parse(request.query);
    return (
      await pool.query(
        "SELECT id,delta,balance_after,kind,created_at FROM credit_transactions WHERE user_id=$1 AND ($2::timestamptz IS NULL OR created_at<$2) ORDER BY created_at DESC,id DESC LIMIT 100",
        [request.actor.id, query.before || null],
      )
    ).rows;
  });
  app.post("/api/v1/reviews", async (request) => {
    requireRole(request, "STUDENT");
    const body = z
      .object({
        subject: z.string().trim().min(1).max(80),
        topic: z.string().trim().min(1).max(160),
        date: z.iso.date(),
      })
      .parse(request.body);
    return tx(async (db) => {
      const review = await one(
        db,
        "INSERT INTO reviews(user_id,subject,topic,study_date) VALUES($1,$2,$3,$4) RETURNING id",
        [request.actor.id, body.subject, body.topic, body.date],
      );
      await db.query(
        "INSERT INTO review_steps(review_id,step,due_date) SELECT $1,n-1,$2::date+days FROM unnest(ARRAY[1,7,30,90]) WITH ORDINALITY AS t(days,n)",
        [review!.id, body.date],
      );
      return { ...body, id: review!.id, done: [false, false, false, false] };
    });
  });
  app.patch("/api/v1/reviews/:id/steps/:index", async (request) => {
    const params = z
      .object({ id: uid, index: z.coerce.number().int().min(0).max(3) })
      .parse(request.params);
    const { done } = z.object({ done: z.boolean() }).parse(request.body);
    const result = await pool.query(
      "UPDATE review_steps SET done=$3 WHERE review_id=$1 AND step=$2 AND EXISTS(SELECT 1 FROM reviews WHERE id=$1 AND user_id=$4)",
      [params.id, params.index, done, request.actor.id],
    );
    if (!result.rowCount) throw new HttpError(404, "Ripasso non trovato");
    return { success: true };
  });
  app.post("/api/v1/associations", async (request) => {
    requireRole(request, "STUDENT");
    const fields: Record<string, string> = {};
    let image: Buffer | undefined;
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "image" || image)
          throw new HttpError(400, "Un solo file immagine consentito");
        image = await part.toBuffer();
        if (part.file.truncated)
          throw new HttpError(413, "Immagine superiore a 200 KB");
      } else if (typeof part.value === "string")
        fields[part.fieldname] = part.value;
    }
    const data = z
      .object({
        number: z.string().regex(/^\d{1,12}$/),
        word: z.string().trim().min(1).max(120),
      })
      .parse(fields);
    const imageKey = image
      ? `images/${request.actor.id}/${randomUUID()}.webp`
      : null;
    if (image && imageKey) await putImage(imageKey, await validateImage(image));
    try {
      const result = await one(
        pool,
        "INSERT INTO associations(user_id,number,word,image_key) VALUES($1,$2,$3,$4) RETURNING id",
        [request.actor.id, data.number, data.word, imageKey],
      );
      return {
        ...data,
        ...result,
        image: imageKey ? await signed(imageKey) : null,
      };
    } catch (error) {
      if (imageKey) await remove(imageKey).catch(() => {});
      throw error;
    }
  });
  app.get(
    "/api/v1/lessons",
    { config: { public: true } },
    async () =>
      (
        await pool.query(
          "SELECT id,title,introduction FROM lessons WHERE active ORDER BY title",
        )
      ).rows,
  );
  app.get("/api/v1/lessons/introduction", async () => {
    const lesson = await one(
      pool,
      "SELECT storage_key FROM lessons WHERE introduction AND active LIMIT 1",
    );
    return {
      videoUrl: lesson?.storage_key ? await signed(lesson.storage_key) : null,
    };
  });
  app.get("/api/v1/lessons/:id/video", async (request) => {
    const id = uid.parse((request.params as { id: string }).id);
    const lesson = await one(
      pool,
      "SELECT storage_key FROM lessons l WHERE id=$1 AND active AND (introduction OR EXISTS(SELECT 1 FROM orders WHERE lesson_id=l.id AND user_id=$2))",
      [id, request.actor.id],
    );
    if (!lesson)
      throw new HttpError(404, "Lezione non trovata o non acquistata");
    if (!lesson.storage_key)
      throw new HttpError(409, "Contenuto non ancora disponibile");
    return { videoUrl: await signed(lesson.storage_key), expiresIn: 300 };
  });
  app.post("/api/v1/orders", async (request) => {
    requireRole(request, "STUDENT");
    const body = z
      .object({
        product: z.enum(["single", "bundle"]),
        topic: z.string().min(1).max(120),
      })
      .parse(request.body);
    const idem = key(request);
    return tx(async (db) => {
      const lesson = await one(
        db,
        "SELECT id FROM lessons WHERE title=$1 AND active AND NOT introduction",
        [body.topic],
      );
      if (!lesson) throw new HttpError(404, "Lezione non disponibile");
      const movement = await moveCredits(
        db,
        request.actor.id,
        body.product === "single" ? -8 : -15,
        body.product === "single" ? "LESSON" : "BUNDLE",
        `${body.product}:${lesson.id}`,
        `order:${idem}`,
      );
      let order = await one(
        db,
        "SELECT id FROM orders WHERE transaction_id=$1",
        [movement.id],
      );
      if (!order) {
        order = await one(
          db,
          "INSERT INTO orders(user_id,lesson_id,product,transaction_id) VALUES($1,$2,$3,$4) RETURNING id",
          [request.actor.id, lesson.id, body.product, movement.id],
        );
        if (body.product === "bundle")
          await db.query(
            "INSERT INTO call_entitlements(user_id,order_id) VALUES($1,$2)",
            [request.actor.id, order!.id],
          );
      }
      return { orderId: order!.id, balance: movement.balance_after };
    });
  });
  app.get(
    "/api/v1/tutors",
    async () =>
      (
        await pool.query(
          "SELECT id,first_name,last_name FROM users WHERE role='TUTOR' AND NOT disabled AND zoom_user_id IS NOT NULL ORDER BY last_name,id LIMIT 100",
        )
      ).rows,
  );
  app.get("/api/v1/availability", async (request) => {
    const query = z
      .object({ tutor: uid, date: z.iso.date() })
      .parse(request.query);
    return (
      await pool.query(
        "SELECT s.id,to_char(starts_at AT TIME ZONE 'Europe/Rome','HH24:MI') AS time FROM tutor_slots s JOIN users u ON u.id=s.tutor_id WHERE s.tutor_id=$1 AND (s.starts_at AT TIME ZONE 'Europe/Rome')::date=$2 AND starts_at>now() AND NOT u.disabled AND u.zoom_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.slot_id=s.id) ORDER BY starts_at",
        [query.tutor, query.date],
      )
    ).rows.map((r) => r.time);
  });
  app.post("/api/v1/tutor/slots", async (request) => {
    requireRole(request, "TUTOR", "ADMIN");
    const body = z
      .object({
        startsAt: z.iso.datetime({ offset: true }),
        tutorId: uid.optional(),
      })
      .parse(request.body);
    const tutorId =
      request.actor.role === "ADMIN"
        ? body.tutorId || request.actor.id
        : request.actor.id;
    if (new Date(body.startsAt) <= new Date())
      throw new HttpError(400, "Scegli un orario futuro");
    const tutor = await one(
      pool,
      "SELECT id FROM users WHERE id=$1 AND role='TUTOR' AND zoom_user_id IS NOT NULL AND NOT disabled",
      [tutorId],
    );
    if (!tutor) throw new HttpError(409, "Tutor non configurato per Zoom");
    return one(
      pool,
      "INSERT INTO tutor_slots(tutor_id,starts_at,ends_at) VALUES($1,$2,$2::timestamptz+interval '1 hour') RETURNING *",
      [tutorId, body.startsAt],
    );
  });
  app.get("/api/v1/tutor/bookings", async (request) => {
    requireRole(request, "TUTOR");
    return (
      await pool.query(
        "SELECT b.id,b.status,b.zoom_meeting_id,s.starts_at,s.ends_at,u.first_name,u.last_name FROM bookings b JOIN tutor_slots s ON s.id=b.slot_id JOIN users u ON u.id=b.student_id WHERE s.tutor_id=$1 AND s.ends_at>now() ORDER BY s.starts_at LIMIT 100",
        [request.actor.id],
      )
    ).rows;
  });
  app.post("/api/v1/bookings", async (request, reply) => {
    requireRole(request, "STUDENT");
    if (
      !config.ZOOM_ACCOUNT_ID ||
      !config.ZOOM_CLIENT_ID ||
      !config.ZOOM_CLIENT_SECRET
    )
      throw new HttpError(
        503,
        "Prenotazioni non ancora attive: configurare Zoom",
      );
    const body = z
      .object({
        tutor: uid,
        date: z.iso.date(),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        timezone: z.literal("Europe/Rome"),
        recordingConsent: z.literal(true),
      })
      .parse(request.body);
    const idem = key(request);
    const booking = await tx(async (db) => {
      await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        request.actor.id,
      ]);
      const previous = await one(
        db,
        "SELECT b.*,s.tutor_id,to_char(s.starts_at AT TIME ZONE 'Europe/Rome','YYYY-MM-DD HH24:MI') AS local_time FROM bookings b JOIN tutor_slots s ON s.id=b.slot_id WHERE b.student_id=$1 AND b.idempotency_key=$2",
        [request.actor.id, idem],
      );
      if (previous) {
        if (
          previous.tutor_id !== body.tutor ||
          previous.local_time !== `${body.date} ${body.time}`
        )
          throw new HttpError(409, "Chiave già utilizzata");
        return { id: previous.id, status: previous.status };
      }
      const consent = await one(
        db,
        "SELECT id FROM legal_consents WHERE student_id=$1 AND legal_version=$2 ORDER BY accepted_at DESC LIMIT 1",
        [request.actor.id, LEGAL_VERSION],
      );
      if (isMinor(request.actor.birth_date) && !consent)
        throw new HttpError(
          403,
          "Verifica il consenso del genitore prima di prenotare",
        );
      const slot = await one(
        db,
        "SELECT s.* FROM tutor_slots s JOIN users u ON u.id=s.tutor_id WHERE s.tutor_id=$1 AND starts_at=($2::timestamp AT TIME ZONE 'Europe/Rome') AND starts_at>now() AND NOT u.disabled AND u.zoom_user_id IS NOT NULL FOR UPDATE OF s",
        [body.tutor, `${body.date} ${body.time}`],
      );
      if (!slot) throw new HttpError(409, "Slot non disponibile");
      if (await one(db, "SELECT id FROM bookings WHERE slot_id=$1", [slot.id]))
        throw new HttpError(409, "Slot già prenotato");
      const entitlement = await one(
        db,
        "SELECT id FROM call_entitlements WHERE user_id=$1 AND NOT consumed ORDER BY id LIMIT 1 FOR UPDATE",
        [request.actor.id],
      );
      if (!entitlement)
        throw new HttpError(409, "Acquista un pacchetto con call inclusa");
      await db.query("UPDATE call_entitlements SET consumed=true WHERE id=$1", [
        entitlement.id,
      ]);
      const row = await one(
        db,
        "INSERT INTO bookings(student_id,slot_id,entitlement_id,consent_id,recording_notice_version,idempotency_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,status",
        [
          request.actor.id,
          slot.id,
          entitlement.id,
          consent?.id || null,
          LEGAL_VERSION,
          idem,
        ],
      );
      await enqueue(db, "ZOOM_CREATE", `meeting:${row!.id}`, {
        bookingId: row!.id,
      });
      return row;
    });
    return reply.code(202).send(booking);
  });
  app.get("/api/v1/recordings", async (request) => {
    const result = await pool.query(
      `SELECT r.id,r.storage_key,r.status,b.id AS booking_id,l.title,t.first_name||' '||t.last_name AS tutor,to_char(s.starts_at AT TIME ZONE 'Europe/Rome','YYYY-MM-DD') AS date,(u.recording_id IS NOT NULL) AS unlocked FROM recordings r JOIN bookings b ON b.id=r.booking_id JOIN tutor_slots s ON s.id=b.slot_id JOIN users t ON t.id=s.tutor_id JOIN call_entitlements e ON e.id=b.entitlement_id JOIN orders o ON o.id=e.order_id JOIN lessons l ON l.id=o.lesson_id LEFT JOIN recording_unlocks u ON u.recording_id=r.id AND u.user_id=$1 WHERE b.student_id=$1 ORDER BY r.created_at DESC LIMIT 50`,
      [request.actor.id],
    );
    return Promise.all(
      result.rows.map(async (r) => ({
        id: r.id,
        title: r.title,
        tutor: r.tutor,
        date: r.date,
        status: r.status,
        unlocked: r.unlocked,
        videoUrl:
          r.unlocked && r.status === "READY" && r.storage_key
            ? await signed(r.storage_key)
            : null,
      })),
    );
  });
  app.post("/api/v1/recordings/:id/unlock", async (request) => {
    requireRole(request, "STUDENT");
    const id = uid.parse((request.params as { id: string }).id);
    const record = await tx(async (db) => {
      const recording = await one(
        db,
        "SELECT r.* FROM recordings r JOIN bookings b ON b.id=r.booking_id JOIN tutor_slots s ON s.id=b.slot_id WHERE r.id=$1 AND b.student_id=$2 AND s.ends_at<=now() FOR UPDATE OF r",
        [id, request.actor.id],
      );
      if (!recording) throw new HttpError(404, "Registrazione non trovata");
      if (recording.status !== "READY" || !recording.storage_key)
        throw new HttpError(409, "Registrazione non ancora disponibile");
      const movement = await moveCredits(
        db,
        request.actor.id,
        -3,
        "RECORDING",
        id,
        `recording:${id}`,
      );
      await db.query(
        "INSERT INTO recording_unlocks(recording_id,user_id,transaction_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [id, request.actor.id, movement.id],
      );
      return recording;
    });
    return { videoUrl: await signed(record.storage_key), expiresIn: 300 };
  });
}

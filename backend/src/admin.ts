import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pool, one, tx, type DB } from "./db.js";
import { requireRole, uid, key, resetMail } from "./auth.js";
import { HttpError, unseal } from "./security.js";
import { moveCredits } from "./credits.js";
async function audit(
  db: DB,
  request: FastifyRequest,
  target: string | null,
  action: string,
  reason: string,
  details: unknown = {},
) {
  await db.query(
    "INSERT INTO admin_audit(actor_id,target_id,action,reason,details,ip) VALUES($1,$2,$3,$4,$5,$6)",
    [
      request.actor.id,
      target,
      action,
      reason,
      JSON.stringify(details),
      request.ip,
    ],
  );
}
const reason = z.string().trim().min(10).max(500);
export async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (request) => requireRole(request, "ADMIN"));
  app.get("/users", async (request) => {
    const query = z
      .object({
        search: z.string().max(100).default(""),
        after: uid.optional(),
      })
      .parse(request.query);
    const escaped = query.search.replace(/[\\%_]/g, "\\$&");
    return (
      await pool.query(
        `SELECT u.id,u.email,u.first_name,u.last_name,u.role,u.disabled,u.birth_date,u.email_verified_at,u.zoom_user_id,w.balance,EXISTS(SELECT 1 FROM legal_consents c WHERE c.student_id=u.id) AS parent_consent FROM users u JOIN wallets w ON w.user_id=u.id WHERE (u.email LIKE lower($1) OR lower(u.last_name) LIKE lower($1)) AND ($2::uuid IS NULL OR u.id>$2) ORDER BY u.id LIMIT 50`,
        [`${escaped}%`, query.after || null],
      )
    ).rows;
  });
  app.patch("/users/:id", async (request) => {
    const id = uid.parse((request.params as { id: string }).id);
    const body = z
      .object({
        role: z.enum(["STUDENT", "TUTOR", "ADMIN"]).optional(),
        disabled: z.boolean().optional(),
        zoomUserId: z.string().min(1).max(200).optional(),
        reason,
      })
      .parse(request.body);
    if (
      id === request.actor.id &&
      (body.disabled || (body.role && body.role !== "ADMIN"))
    )
      throw new HttpError(
        400,
        "Non puoi rimuovere il tuo accesso amministrativo",
      );
    await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(731285)");
      const user = await one(db, "SELECT * FROM users WHERE id=$1 FOR UPDATE", [
        id,
      ]);
      if (!user) throw new HttpError(404, "Utente non trovato");
      if (
        user.role === "ADMIN" &&
        (body.disabled || (body.role && body.role !== "ADMIN"))
      ) {
        const count = await one(
          db,
          "SELECT count(*)::int AS n FROM users WHERE role='ADMIN' AND NOT disabled",
        );
        if (count!.n <= 1)
          throw new HttpError(
            409,
            "È necessario mantenere almeno un amministratore",
          );
      }
      await db.query(
        "UPDATE users SET role=COALESCE($2::user_role,role),disabled=COALESCE($3,disabled),zoom_user_id=COALESCE($4,zoom_user_id) WHERE id=$1",
        [id, body.role || null, body.disabled ?? null, body.zoomUserId || null],
      );
      if (body.disabled || body.role)
        await db.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      await audit(db, request, id, "USER_UPDATE", body.reason, {
        role: body.role,
        disabled: body.disabled,
        zoomUserId: body.zoomUserId,
      });
    });
    return { success: true };
  });
  app.post("/users/:id/password-reset", async (request, reply) => {
    const id = uid.parse((request.params as { id: string }).id);
    const body = z.object({ reason }).parse(request.body);
    await tx(async (db) => {
      const user = await one(db, "SELECT email FROM users WHERE id=$1", [id]);
      if (!user) throw new HttpError(404, "Utente non trovato");
      await db.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      await resetMail(db, id, user.email);
      await audit(db, request, id, "PASSWORD_RESET", body.reason);
    });
    return reply.code(202).send({ success: true });
  });
  app.post("/users/:id/credits", async (request) => {
    const id = uid.parse((request.params as { id: string }).id);
    const body = z
      .object({
        delta: z
          .number()
          .int()
          .min(-100000)
          .max(100000)
          .refine((v) => v !== 0),
        reason,
      })
      .parse(request.body);
    return tx(async (db) => {
      const movement = await moveCredits(
        db,
        id,
        body.delta,
        "ADMIN",
        body.reason,
        `admin:${key(request)}`,
        request.actor.id,
      );
      await audit(db, request, id, "CREDIT_ADJUSTMENT", body.reason, {
        transactionId: movement.id,
        delta: body.delta,
      });
      return { balance: movement.balance_after, transactionId: movement.id };
    });
  });
  app.get("/users/:id/credits", async (request) => {
    const id = uid.parse((request.params as { id: string }).id);
    return (
      await pool.query(
        "SELECT id,delta,balance_after,kind,reference,actor_id,created_at FROM credit_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
        [id],
      )
    ).rows;
  });
  app.get("/users/:id/consents", async (request) => {
    const id = uid.parse((request.params as { id: string }).id);
    return tx(async (db) => {
      await audit(
        db,
        request,
        id,
        "CONSENT_VIEW",
        "Consultazione consensi da backoffice",
      );
      const result = await db.query(
        "SELECT id,guardian_encrypted,ip,user_agent,legal_version,accepted_text,accepted_at FROM legal_consents WHERE student_id=$1 ORDER BY accepted_at DESC LIMIT 50",
        [id],
      );
      return result.rows.map((c) => {
        const { guardian_encrypted, ...rest } = c;
        return { ...rest, guardian: unseal(guardian_encrypted) };
      });
    });
  });
  app.get("/operations", async () => ({
    jobs: (
      await pool.query(
        "SELECT id,kind,status,attempts,last_error,created_at FROM jobs WHERE status='FAILED' ORDER BY created_at DESC LIMIT 50",
      )
    ).rows,
    bookings: (
      await pool.query(
        "SELECT id,status,created_at FROM bookings WHERE status='ACTION_REQUIRED' ORDER BY created_at DESC LIMIT 50",
      )
    ).rows,
  }));
  app.post("/jobs/:id/retry", async (request) => {
    const id = uid.parse((request.params as { id: string }).id);
    const { reason: why } = z.object({ reason }).parse(request.body);
    await tx(async (db) => {
      const changed = await db.query(
        "UPDATE jobs SET status='PENDING',attempts=0,available_at=now() WHERE id=$1 AND status='FAILED'",
        [id],
      );
      if (!changed.rowCount) throw new HttpError(409, "Job non ripetibile");
      await audit(db, request, null, "JOB_RETRY", why, { jobId: id });
    });
    return { success: true };
  });
  app.patch("/lessons/:id", async (request) => {
    const id = uid.parse((request.params as { id: string }).id);
    const body = z
      .object({
        storageKey: z
          .string()
          .regex(/^lessons\/[a-zA-Z0-9/_-]+\.mp4$/)
          .max(300),
        reason,
      })
      .parse(request.body);
    await tx(async (db) => {
      const result = await db.query(
        "UPDATE lessons SET storage_key=$2 WHERE id=$1",
        [id, body.storageKey],
      );
      if (!result.rowCount) throw new HttpError(404, "Lezione non trovata");
      await audit(db, request, null, "LESSON_VIDEO_UPDATE", body.reason, {
        lessonId: id,
        storageKey: body.storageKey,
      });
    });
    return { success: true };
  });
}

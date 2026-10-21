import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { one, pool, tx, type DB } from "./db.js";
import {
  token,
  hash,
  passwordHash,
  passwordVerify,
  otpHash,
  equal,
  isMinor,
  seal,
  HttpError,
} from "./security.js";
import { enqueue } from "./jobs.js";
export const LEGAL_VERSION = "parent-recording-v1";
export interface Actor {
  id: string;
  role: "STUDENT" | "TUTOR" | "ADMIN";
  birth_date: string;
  email: string;
  first_name: string;
  last_name: string;
  session_id: string;
  csrf_hash: string;
}
declare module "fastify" {
  interface FastifyRequest {
    actor: Actor;
  }
  interface FastifyContextConfig {
    public?: boolean;
    webhook?: boolean;
  }
}
export function requireRole(
  request: FastifyRequest,
  ...roles: Actor["role"][]
) {
  if (!roles.includes(request.actor.role))
    throw new HttpError(403, "Operazione non autorizzata");
}
export const email = z
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
export const password = z.string().min(12).max(128);
export const date = z.iso
  .date()
  .refine(
    (v) => v >= "1900-01-01" && v <= new Date().toISOString().slice(0, 10),
    "Data di nascita non valida",
  );
export const uid = z.uuid();
export function key(request: FastifyRequest) {
  return z
    .string()
    .min(16)
    .max(128)
    .regex(/^[a-zA-Z0-9:_-]+$/)
    .parse(request.headers["idempotency-key"]);
}
const guardianSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email,
  taxCode: z
    .string()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{16}$/)),
});
// Italian fiscal-code checksum; supports omocodia, never substitutes identity verification.
export function validTaxCode(code: string) {
  if (
    !/^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/.test(
      code,
    )
  )
    return false;
  const odd: Record<string, number> = {};
  const values = [
    1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16,
    10, 22, 25, 24, 23,
  ];
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    .split("")
    .forEach((c, i) => (odd[c] = values[i]!));
  "0123456789".split("").forEach((c, i) => (odd[c] = values[i]!));
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const c = code[i]!;
    sum +=
      i % 2 === 0
        ? odd[c]!
        : /[0-9]/.test(c)
          ? Number(c)
          : c.charCodeAt(0) - 65;
  }
  return String.fromCharCode(65 + (sum % 26)) === code[15];
}
async function authMail(
  db: DB,
  userId: string,
  to: string,
  purpose: "verify" | "reset",
) {
  const raw = token();
  const tokenRow = await one(
    db,
    "INSERT INTO auth_tokens(user_id,token_hash,purpose,expires_at) VALUES($1,$2,$3,now()+interval '30 minutes') RETURNING id",
    [userId, hash(raw), purpose],
  );
  await enqueue(db, "EMAIL", `auth:${tokenRow!.id}`, {
    to,
    subject:
      purpose === "verify"
        ? "Verifica il tuo account Radice"
        : "Reimposta la password Radice",
    text: `Apri ${config.APP_ORIGIN}/account#${purpose}=${raw}\nIl link scade dopo 30 minuti. Se non hai richiesto questa operazione, ignoralo.`,
  });
}
export async function resetMail(db: DB, userId: string, to: string) {
  await authMail(db, userId, to, "reset");
}
async function challenge(
  db: DB,
  userId: string,
  guardian: z.infer<typeof guardianSchema>,
) {
  const id = randomUUID(),
    code = String(randomInt(100000, 1000000));
  await db.query(
    "UPDATE parent_challenges SET expires_at=now() WHERE student_id=$1 AND verified_at IS NULL",
    [userId],
  );
  await db.query(
    "INSERT INTO parent_challenges(id,student_id,guardian_encrypted,otp_hash,legal_version,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
    [id, userId, seal(guardian), otpHash(id, code), LEGAL_VERSION],
  );
  const legal = await one(
    db,
    "SELECT body FROM legal_versions WHERE version=$1",
    [LEGAL_VERSION],
  );
  await enqueue(db, "EMAIL", `parent:${id}`, {
    to: guardian.email,
    subject: "Radice · Verifica del consenso genitoriale",
    text: `Richiesta di iscrizione di un minore. Usa il codice solo se sei il tutore e accetti il testo seguente:\n\n${legal!.body}\n\nCodice: ${code}\nValido per 10 minuti. Non condividere il codice se non autorizzi l’iscrizione.`,
  });
  return id;
}
export async function authPlugin(app: FastifyInstance) {
  app.decorateRequest("actor");
  app.addHook("onRequest", async (request) => {
    if (request.method === "OPTIONS") return;
    if (
      !["GET", "HEAD"].includes(request.method) &&
      !request.routeOptions.config.webhook
    ) {
      if (request.headers.origin !== config.APP_ORIGIN)
        throw new HttpError(403, "Origin non autorizzata");
    }
    if (request.routeOptions.config.public) return;
    const raw = request.cookies.radice_session;
    if (!raw) throw new HttpError(401, "Accedi per continuare");
    const actor = await one<Actor>(
      pool,
      `SELECT u.id,u.email,u.role,u.birth_date,u.first_name,u.last_name,s.id AS session_id,s.csrf_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled AND u.email_verified_at IS NOT NULL`,
      [hash(raw)],
    );
    if (!actor) throw new HttpError(401, "Sessione scaduta");
    request.actor = actor;
    if (!["GET", "HEAD"].includes(request.method)) {
      const csrf = request.headers["x-csrf-token"];
      if (typeof csrf !== "string" || !equal(hash(csrf), actor.csrf_hash))
        throw new HttpError(403, "Token CSRF non valido");
    }
  });
  const publicRoute = {
    config: { public: true, rateLimit: { max: 10, timeWindow: "15 minutes" } },
  };
  app.get("/api/v1/legal/parent", { config: { public: true } }, async () =>
    one(pool, "SELECT version,body FROM legal_versions WHERE version=$1", [
      LEGAL_VERSION,
    ]),
  );
  app.post("/api/v1/registrations", publicRoute, async (request, reply) => {
    const body = z
      .object({
        email,
        password,
        firstName: z.string().trim().min(1).max(80),
        lastName: z.string().trim().min(1).max(80),
        birthDate: date,
        privacy: z.union([z.literal(true), z.literal("on")]),
        parentFirstName: z.string().optional(),
        parentLastName: z.string().optional(),
        parentEmail: z.string().optional(),
        taxCode: z.string().optional(),
        parentConsent: z.boolean().optional(),
        legalVersion: z.string().optional(),
      })
      .parse(request.body);
    const minor = isMinor(body.birthDate);
    let guardian: z.infer<typeof guardianSchema> | undefined;
    if (minor) {
      guardian = guardianSchema.parse({
        firstName: body.parentFirstName,
        lastName: body.parentLastName,
        email: body.parentEmail,
        taxCode: body.taxCode,
      });
      if (guardian.email === body.email)
        throw new HttpError(
          400,
          "Usa un indirizzo del genitore diverso da quello dello studente",
        );
      if (!validTaxCode(guardian.taxCode))
        throw new HttpError(400, "Codice fiscale non valido");
      if (!body.parentConsent || body.legalVersion !== LEGAL_VERSION)
        throw new HttpError(
          400,
          "È necessario accettare il testo legale corrente",
        );
    }
    const secret = await passwordHash(body.password);
    const result = await tx(async (db) => {
      const user = await one(
        db,
        "INSERT INTO users(email,first_name,last_name,birth_date,password_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(email) DO NOTHING RETURNING id",
        [body.email, body.firstName, body.lastName, body.birthDate, secret],
      );
      if (!user) return { registrationId: randomUUID(), requiresOtp: minor };
      await db.query("INSERT INTO wallets(user_id) VALUES($1)", [user.id]);
      await authMail(db, user.id, body.email, "verify");
      const registrationId = guardian
        ? await challenge(db, user.id, guardian)
        : user.id;
      return { registrationId, requiresOtp: minor };
    });
    return reply.code(202).send(result);
  });
  app.post(
    "/api/v1/registrations/:id/verify-parent",
    publicRoute,
    async (request) => {
      const id = uid.parse((request.params as { id: string }).id),
        { code } = z
          .object({ code: z.string().regex(/^\d{6}$/) })
          .parse(request.body);
      const success = await tx(async (db) => {
        const pending = await one(
          db,
          "SELECT * FROM parent_challenges WHERE id=$1 FOR UPDATE",
          [id],
        );
        if (
          !pending ||
          pending.verified_at ||
          pending.attempts >= 5 ||
          new Date(pending.expires_at) <= new Date()
        )
          return false;
        await db.query(
          "UPDATE parent_challenges SET attempts=attempts+1 WHERE id=$1",
          [id],
        );
        if (!equal(otpHash(id, code), pending.otp_hash)) return false;
        await db.query(
          "INSERT INTO legal_consents(student_id,challenge_id,guardian_encrypted,ip,user_agent,legal_version,accepted_text) SELECT $1,$2,$3,$4,$5,version,body FROM legal_versions WHERE version=$6",
          [
            pending.student_id,
            id,
            pending.guardian_encrypted,
            request.ip,
            (request.headers["user-agent"] || "").slice(0, 1000),
            pending.legal_version,
          ],
        );
        await db.query(
          "UPDATE parent_challenges SET verified_at=now() WHERE id=$1",
          [id],
        );
        return true;
      });
      if (!success)
        throw new HttpError(400, "Codice non valido, scaduto o già utilizzato");
      return { verified: true };
    },
  );
  app.post(
    "/api/v1/consents/request",
    { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } },
    async (request, reply) => {
      requireRole(request, "STUDENT");
      const body = z
        .object({
          guardian: guardianSchema,
          accepted: z.literal(true),
          legalVersion: z.literal(LEGAL_VERSION),
        })
        .parse(request.body);
      if (body.guardian.email === request.actor.email)
        throw new HttpError(
          400,
          "Usa un indirizzo del genitore diverso da quello dello studente",
        );
      if (!validTaxCode(body.guardian.taxCode))
        throw new HttpError(400, "Codice fiscale non valido");
      const id = await tx((db) =>
        challenge(db, request.actor.id, body.guardian),
      );
      return reply.code(202).send({ registrationId: id, requiresOtp: true });
    },
  );
  const dummy = await passwordHash(token());
  app.post("/api/v1/auth/login", publicRoute, async (request, reply) => {
    const body = z
      .object({ email, password: z.string().min(1).max(128) })
      .parse(request.body);
    const user = await one(pool, "SELECT * FROM users WHERE email=$1", [
      body.email,
    ]);
    const valid = await passwordVerify(
      body.password,
      user?.password_hash || dummy,
    );
    if (!valid || !user || user.disabled || !user.email_verified_at)
      throw new HttpError(401, "Credenziali non valide o email non verificata");
    const raw = token(),
      csrf = otpHash("csrf", raw);
    await pool.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')",
      [user.id, hash(raw), hash(csrf)],
    );
    reply.setCookie("radice_session", raw, {
      httpOnly: true,
      secure: config.COOKIE_SECURE === "true",
      sameSite: "strict",
      path: "/",
      maxAge: 43200,
    });
    return {
      user: { id: user.id, email: user.email, role: user.role },
      csrfToken: csrf,
    };
  });
  app.get("/api/v1/auth/session", async (request) => {
    const csrf = otpHash("csrf", request.cookies.radice_session!);
    return {
      user: {
        id: request.actor.id,
        role: request.actor.role,
        email: request.actor.email,
      },
      csrfToken: csrf,
    };
  });
  app.post("/api/v1/auth/logout", async (request, reply) => {
    await pool.query("DELETE FROM sessions WHERE id=$1", [
      request.actor.session_id,
    ]);
    reply.clearCookie("radice_session", { path: "/" });
    return { success: true };
  });
  app.post(
    "/api/v1/auth/forgot-password",
    publicRoute,
    async (request, reply) => {
      const body = z.object({ email }).parse(request.body);
      await tx(async (db) => {
        const user = await one(
          db,
          "SELECT id FROM users WHERE email=$1 AND NOT disabled",
          [body.email],
        );
        if (user) await resetMail(db, user.id, body.email);
      });
      return reply.code(202).send({
        message: "Se l’account esiste riceverai le istruzioni via email.",
      });
    },
  );
  app.post(
    "/api/v1/auth/resend-verification",
    publicRoute,
    async (request, reply) => {
      const body = z.object({ email }).parse(request.body);
      await tx(async (db) => {
        const user = await one(
          db,
          "SELECT id FROM users WHERE email=$1 AND NOT disabled AND email_verified_at IS NULL",
          [body.email],
        );
        if (user) await authMail(db, user.id, body.email, "verify");
      });
      return reply.code(202).send({ success: true });
    },
  );
  app.post("/api/v1/auth/verify-email", publicRoute, async (request) => {
    const { token: raw } = z
      .object({ token: z.string().min(30).max(100) })
      .parse(request.body);
    await tx(async (db) => {
      const item = await one(
        db,
        "SELECT * FROM auth_tokens WHERE token_hash=$1 AND purpose='verify' AND used_at IS NULL AND expires_at>now() FOR UPDATE",
        [hash(raw)],
      );
      if (!item) throw new HttpError(400, "Link non valido o scaduto");
      await db.query(
        "UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1",
        [item.user_id],
      );
      await db.query("UPDATE auth_tokens SET used_at=now() WHERE id=$1", [
        item.id,
      ]);
    });
    return { verified: true };
  });
  app.post("/api/v1/auth/reset-password", publicRoute, async (request) => {
    const body = z
      .object({ token: z.string().min(30).max(100), password })
      .parse(request.body);
    const secret = await passwordHash(body.password);
    await tx(async (db) => {
      const item = await one(
        db,
        "SELECT * FROM auth_tokens WHERE token_hash=$1 AND purpose='reset' AND used_at IS NULL AND expires_at>now() FOR UPDATE",
        [hash(body.token)],
      );
      if (!item) throw new HttpError(400, "Link non valido o scaduto");
      await db.query("UPDATE users SET password_hash=$2 WHERE id=$1", [
        item.user_id,
        secret,
      ]);
      await db.query(
        "UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND purpose='reset' AND used_at IS NULL",
        [item.user_id],
      );
      await db.query("DELETE FROM sessions WHERE user_id=$1", [item.user_id]);
    });
    return { success: true };
  });
}

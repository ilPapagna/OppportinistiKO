import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac, randomInt } from "node:crypto";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { pool, tx, one } from "../src/db.js";
import { config } from "../src/config.js";
import { passwordHash, unseal } from "../src/security.js";
import { moveCredits } from "../src/credits.js";
import { validateImage } from "../src/storage.js";
import { LEGAL_VERSION, validTaxCode } from "../src/auth.js";
import { verifyZoomSignature, zoomDownloadURL } from "../src/zoom.js";
import { applyPaidSession } from "../src/payments.js";
import type Stripe from "stripe";
if (!new URL(config.DATABASE_URL).pathname.endsWith("_test"))
  throw new Error("Dedicated *_test database required");
let app: FastifyInstance,
  serial = 1;
const runNetwork = `${randomInt(1, 254)}.${randomInt(1, 254)}`;
const password = "Secure-test-password-123";
type User = { id: string; email: string; cookie: string; csrf: string };
let student: User, other: User, minor: User, admin: User, tutor: User;
async function send(
  method: string,
  url: string,
  payload?: unknown,
  user?: User,
  extra: Record<string, string> = {},
) {
  return app.inject({
    method: method as "GET" | "POST" | "PATCH",
    url,
    headers: {
      origin: config.APP_ORIGIN,
      ...(user ? { cookie: user.cookie, "x-csrf-token": user.csrf } : {}),
      "idempotency-key": randomUUID(),
      ...extra,
    },
    payload: payload as Record<string, unknown>,
    remoteAddress: `10.${runNetwork}.${(serial++ % 240) + 1}`,
  });
}
async function login(id: string, email: string) {
  const r = await send("POST", "/api/v1/auth/login", { email, password });
  assert.equal(r.statusCode, 200, r.body);
  return {
    id,
    email,
    cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    csrf: r.json().csrfToken,
  };
}
async function fixture(role = "STUDENT", birth = "1995-01-01") {
  const email = `${randomUUID()}@example.test`;
  const r = await one(
    pool,
    "INSERT INTO users(email,first_name,last_name,birth_date,password_hash,role,email_verified_at,zoom_user_id) VALUES($1,$2,$3,$4,$5,$6,now(),$7) RETURNING id",
    [
      email,
      "Test",
      "Radice",
      birth,
      await passwordHash(password),
      role,
      role === "TUTOR" ? `zoom-${randomUUID()}` : null,
    ],
  );
  await pool.query("INSERT INTO wallets(user_id) VALUES($1)", [r!.id]);
  return login(r!.id, email);
}
async function fund(u: User, amount = 50) {
  await tx((db) =>
    moveCredits(
      db,
      u.id,
      amount,
      "ADMIN",
      "test fixture",
      randomUUID(),
      admin.id,
    ),
  );
}
async function bundle(u: User) {
  const r = await send(
    "POST",
    "/api/v1/orders",
    { product: "bundle", topic: "Metodo dei Loci" },
    u,
  );
  assert.equal(r.statusCode, 200, r.body);
}
async function slot(days: number) {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + days);
  start.setUTCHours(10, 0, 0, 0);
  const r = await send(
    "POST",
    "/api/v1/tutor/slots",
    { startsAt: start.toISOString() },
    tutor,
  );
  assert.equal(r.statusCode, 200, r.body);
  return {
    tutor: tutor.id,
    date: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Rome",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(start),
    time: new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Rome",
      hour: "2-digit",
      minute: "2-digit",
    }).format(start),
    timezone: "Europe/Rome",
    recordingConsent: true,
  };
}
before(async () => {
  app = await buildApp();
  await app.ready();
  admin = await fixture("ADMIN");
  student = await fixture();
  other = await fixture();
  minor = await fixture("STUDENT", "2014-01-01");
  tutor = await fixture("TUTOR");
});
after(async () => {
  await app?.close();
  await pool.end();
});
test("PostgreSQL and Redis readiness", async () =>
  assert.equal((await send("GET", "/health/ready")).statusCode, 200));
test("authentication and ADMIN authorization", async () => {
  assert.equal((await send("GET", "/api/v1/me/dashboard")).statusCode, 401);
  assert.equal(
    (await send("GET", "/api/v1/admin/users", undefined, student)).statusCode,
    403,
  );
});
test("Origin and CSRF enforcement", async () => {
  const b = { subject: "A", topic: "B", date: "2026-10-20" };
  assert.equal(
    (
      await send("POST", "/api/v1/reviews", b, student, {
        "x-csrf-token": "bad",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await send("POST", "/api/v1/reviews", b, student, {
        origin: "https://evil.test",
      })
    ).statusCode,
    403,
  );
});
test("stable CSRF across tabs", async () => {
  const a = await send("GET", "/api/v1/auth/session", undefined, student),
    b = await send("GET", "/api/v1/auth/session", undefined, student);
  assert.equal(a.json().csrfToken, student.csrf);
  assert.equal(a.json().csrfToken, b.json().csrfToken);
});
test("review calendar dates through DST and ownership", async () => {
  const r = await send(
    "POST",
    "/api/v1/reviews",
    { subject: "Storia", topic: "Rinascimento", date: "2026-10-24" },
    student,
  );
  assert.equal(r.statusCode, 200, r.body);
  const dashboard = await send(
    "GET",
    "/api/v1/me/dashboard",
    undefined,
    student,
  );
  const review = dashboard
    .json()
    .reviews.find((x: { id: string }) => x.id === r.json().id);
  assert.deepEqual(review.dates, [
    "2026-10-25",
    "2026-10-31",
    "2026-11-23",
    "2027-01-22",
  ]);
  assert.equal(
    (
      await send(
        "PATCH",
        `/api/v1/reviews/${review.id}/steps/0`,
        { done: true },
        other,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await send(
        "PATCH",
        `/api/v1/reviews/${review.id}/steps/0`,
        { done: true },
        student,
      )
    ).statusCode,
    200,
  );
});
test("concurrent credits never overdraw", async () => {
  await fund(other, 16);
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      tx((db) =>
        moveCredits(db, other.id, -8, "LESSON", "concurrency", randomUUID()),
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(
    (await one(pool, "SELECT balance FROM wallets WHERE user_id=$1", [
      other.id,
    ]))!.balance,
    0,
  );
});
test("idempotent purchases and payload mismatch", async () => {
  await fund(student, 50);
  const idem = randomUUID();
  const rs = await Promise.all(
    Array.from({ length: 8 }, () =>
      send(
        "POST",
        "/api/v1/orders",
        { product: "bundle", topic: "Metodo dei Loci" },
        student,
        { "idempotency-key": idem },
      ),
    ),
  );
  rs.forEach((r) => assert.equal(r.statusCode, 200, r.body));
  assert.equal(new Set(rs.map((r) => r.json().orderId)).size, 1);
  assert.equal(
    (await one(pool, "SELECT balance FROM wallets WHERE user_id=$1", [
      student.id,
    ]))!.balance,
    35,
  );
  assert.equal(
    (
      await send(
        "POST",
        "/api/v1/orders",
        { product: "single", topic: "Metodo dei Loci" },
        student,
        { "idempotency-key": idem },
      )
    ).statusCode,
    409,
  );
});
test("ledger rejects UPDATE DELETE TRUNCATE", async () => {
  await assert.rejects(
    pool.query("UPDATE credit_transactions SET delta=1 WHERE user_id=$1", [
      student.id,
    ]),
    /immutable/,
  );
  await assert.rejects(
    pool.query("DELETE FROM credit_transactions WHERE user_id=$1", [
      student.id,
    ]),
    /immutable/,
  );
  await assert.rejects(
    pool.query("TRUNCATE credit_transactions CASCADE"),
    /immutable/,
  );
});
test("minor blocked before parent validation", async () => {
  await fund(minor, 30);
  await bundle(minor);
  assert.equal(
    (await send("POST", "/api/v1/bookings", await slot(6), minor)).statusCode,
    403,
  );
});
test("OTP audit, attempts, encrypted guardian data and immutable consent", async () => {
  const taxCode = Array.from(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    (c) => "RSSMRC80A01H501" + c,
  ).find(validTaxCode)!;
  assert.ok(taxCode);
  const r = await send(
    "POST",
    "/api/v1/consents/request",
    {
      guardian: {
        firstName: "Marco",
        lastName: "Rossi",
        email: "parent@example.test",
        taxCode,
      },
      accepted: true,
      legalVersion: LEGAL_VERSION,
    },
    minor,
  );
  assert.equal(r.statusCode, 202, r.body);
  const id = r.json().registrationId;
  const job = await one(
    pool,
    "SELECT payload_encrypted FROM jobs WHERE dedup_key=$1",
    [`parent:${id}`],
  );
  assert.ok(!job!.payload_encrypted.includes("parent@example.test"));
  const code = /Codice: (\d{6})/.exec(
    unseal<{ text: string }>(job!.payload_encrypted).text,
  )![1]!;
  assert.equal(
    (
      await send("POST", `/api/v1/registrations/${id}/verify-parent`, {
        code: "000000",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await one(pool, "SELECT attempts FROM parent_challenges WHERE id=$1", [
      id,
    ]))!.attempts,
    1,
  );
  assert.equal(
    (
      await send(
        "POST",
        `/api/v1/registrations/${id}/verify-parent`,
        { code },
        undefined,
        { "user-agent": "Test browser" },
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await send("POST", `/api/v1/registrations/${id}/verify-parent`, { code }))
      .statusCode,
    400,
  );
  const c = await one(
    pool,
    "SELECT * FROM legal_consents WHERE challenge_id=$1",
    [id],
  );
  assert.equal(c!.legal_version, LEGAL_VERSION);
  assert.equal(c!.user_agent, "Test browser");
  assert.ok(c!.accepted_at);
  assert.equal(
    unseal<{ taxCode: string }>(c!.guardian_encrypted).taxCode,
    taxCode,
  );
  await assert.rejects(
    pool.query("UPDATE legal_consents SET user_agent=$2 WHERE id=$1", [
      c!.id,
      "changed",
    ]),
    /immutable/,
  );
  assert.equal(
    (
      await send(
        "GET",
        `/api/v1/admin/users/${minor.id}/consents`,
        undefined,
        student,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await send(
        "GET",
        `/api/v1/admin/users/${minor.id}/consents`,
        undefined,
        admin,
      )
    ).json()[0].guardian.taxCode,
    taxCode,
  );
});
test("OTP locks after five failed attempts", async () => {
  const r = await one(
    pool,
    "INSERT INTO parent_challenges(student_id,guardian_encrypted,otp_hash,legal_version,expires_at) VALUES($1,'test','test',$2,now()+interval '10 minutes') RETURNING id",
    [minor.id, LEGAL_VERSION],
  );
  for (let i = 0; i < 6; i++)
    assert.equal(
      (
        await send("POST", `/api/v1/registrations/${r!.id}/verify-parent`, {
          code: "111111",
        })
      ).statusCode,
      400,
    );
  assert.equal(
    (await one(pool, "SELECT attempts FROM parent_challenges WHERE id=$1", [
      r!.id,
    ]))!.attempts,
    5,
  );
});
test("overlapping tutor slots fail", async () => {
  await slot(8);
  const s = await one(
    pool,
    "SELECT starts_at FROM tutor_slots WHERE tutor_id=$1 ORDER BY starts_at DESC LIMIT 1",
    [tutor.id],
  );
  assert.equal(
    (
      await send(
        "POST",
        "/api/v1/tutor/slots",
        {
          startsAt: new Date(
            new Date(s!.starts_at).getTime() + 1800000,
          ).toISOString(),
        },
        tutor,
      )
    ).statusCode,
    409,
  );
});
test("concurrent booking consumes one call and enqueues one job", async () => {
  const body = await slot(10),
    idem = randomUUID();
  const rs = await Promise.all(
    Array.from({ length: 6 }, () =>
      send("POST", "/api/v1/bookings", body, minor, {
        "idempotency-key": idem,
      }),
    ),
  );
  rs.forEach((r) => assert.equal(r.statusCode, 202, r.body));
  const id = rs[0]!.json().id;
  assert.equal(new Set(rs.map((r) => r.json().id)).size, 1);
  assert.equal(rs[0]!.json().status, "PROVISIONING");
  assert.equal(
    (await one(pool, "SELECT count(*)::int AS n FROM jobs WHERE dedup_key=$1", [
      `meeting:${id}`,
    ]))!.n,
    1,
  );
  assert.equal(
    (await send("POST", "/api/v1/bookings", body, student)).statusCode,
    409,
  );
});
test("recording ownership and atomic once-only unlock", async () => {
  const b = await one(
    pool,
    "SELECT id,slot_id FROM bookings WHERE student_id=$1 LIMIT 1",
    [minor.id],
  );
  assert.ok(b);
  await pool.query(
    "UPDATE tutor_slots SET starts_at=now()-interval '3 hours',ends_at=now()-interval '2 hours' WHERE id=$1",
    [b.slot_id],
  );
  const r = await one(
    pool,
    "INSERT INTO recordings(booking_id,zoom_file_id,storage_key,status) VALUES($1,$2,'recordings/test.mp4','READY') RETURNING id",
    [b.id, randomUUID()],
  );
  assert.equal(
    (await send("POST", `/api/v1/recordings/${r!.id}/unlock`, {}, student))
      .statusCode,
    404,
  );
  const before = (await one(
    pool,
    "SELECT balance FROM wallets WHERE user_id=$1",
    [minor.id],
  ))!.balance;
  const rs = await Promise.all(
    Array.from({ length: 10 }, () =>
      send("POST", `/api/v1/recordings/${r!.id}/unlock`, {}, minor),
    ),
  );
  rs.forEach((r) => {
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(
      new URL(r.json().videoUrl).searchParams.get("X-Amz-Expires"),
      "300",
    );
  });
  assert.equal(
    (await one(pool, "SELECT balance FROM wallets WHERE user_id=$1", [
      minor.id,
    ]))!.balance,
    before - 3,
  );
});
test("audited admin adjustment and negative balance protection", async () => {
  const r = await send(
    "POST",
    `/api/v1/admin/users/${student.id}/credits`,
    { delta: 5, reason: "Correzione amministrativa di prova" },
    admin,
  );
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(
    (
      await send(
        "POST",
        `/api/v1/admin/users/${student.id}/credits`,
        { delta: -1000, reason: "Rettifica non disponibile" },
        admin,
      )
    ).statusCode,
    409,
  );
  assert.ok(
    await one(
      pool,
      "SELECT id FROM admin_audit WHERE target_id=$1 AND action='CREDIT_ADJUSTMENT'",
      [student.id],
    ),
  );
});
test("admin self-demotion blocked", async () =>
  assert.equal(
    (
      await send(
        "PATCH",
        `/api/v1/admin/users/${admin.id}`,
        { role: "STUDENT", reason: "Tentativo auto rimozione" },
        admin,
      )
    ).statusCode,
    400,
  ));
test("image validates actual encoding, size and strips to WebP", async () => {
  await assert.rejects(
    validateImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
  );
  await assert.rejects(validateImage(Buffer.from("not an image")));
  await assert.rejects(validateImage(Buffer.alloc(201 * 1024)));
  const png = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  assert.equal(
    (await sharp(await validateImage(png)).metadata()).format,
    "webp",
  );
});
test("Zoom rejects invalid signature, expired replay and SSRF URLs", () => {
  const raw = '{"event":"recording.completed"}',
    ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", "secret").update(`v0:${ts}:${raw}`).digest("hex")}`;
  assert.equal(verifyZoomSignature(raw, ts, sig, "secret"), true);
  assert.equal(verifyZoomSignature(raw + " ", ts, sig, "secret"), false);
  assert.equal(
    verifyZoomSignature(raw, ts, sig, "secret", Date.now() + 600000),
    false,
  );
  assert.throws(() =>
    zoomDownloadURL("http://169.254.169.254/latest/meta-data"),
  );
  assert.throws(() => zoomDownloadURL("https://zoom.us.evil.test/file"));
});
test("signed Zoom webhook validation and duplicate delivery", async () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const sign = (body: unknown) => ({
    "x-zm-request-timestamp": ts,
    "x-zm-signature": `v0=${createHmac("sha256", config.ZOOM_WEBHOOK_SECRET!)
      .update(`v0:${ts}:${JSON.stringify(body)}`)
      .digest("hex")}`,
  });
  const crc = {
    event: "endpoint.url_validation",
    payload: { plainToken: "example" },
  };
  const r = await send(
    "POST",
    "/api/v1/webhooks/zoom",
    crc,
    undefined,
    sign(crc),
  );
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(
    r.json().encryptedToken,
    createHmac("sha256", config.ZOOM_WEBHOOK_SECRET!)
      .update("example")
      .digest("hex"),
  );
  const body = {
    event: "recording.completed",
    event_ts: Date.now(),
    payload: {
      account_id: "test-account",
      object: {
        id: "123456",
        uuid: randomUUID(),
        recording_files: [
          {
            id: randomUUID(),
            file_type: "MP4",
            status: "completed",
            download_url: "https://us02web.zoom.us/rec/download/test",
          },
        ],
      },
    },
  };
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await send("POST", "/api/v1/webhooks/zoom", body, undefined, sign(body)))
        .statusCode,
      200,
    );
  assert.equal(
    (
      await send("POST", "/api/v1/webhooks/zoom", body, undefined, {
        ...sign(body),
        "x-zm-signature": "v0=bad",
      })
    ).statusCode,
    401,
  );
});
test("payment settles once and verifies server amount", async () => {
  const order = await one(
    pool,
    "INSERT INTO checkout_orders(user_id,credits,amount_cents,idempotency_key) VALUES($1,15,1500,$2) RETURNING id",
    [other.id, randomUUID()],
  );
  const s = {
    id: `cs_${randomUUID()}`,
    mode: "payment",
    payment_status: "paid",
    amount_total: 1500,
    currency: "eur",
    metadata: { orderId: order!.id, userId: other.id },
  } as unknown as Stripe.Checkout.Session;
  await assert.rejects(applyPaidSession({ ...s, amount_total: 1 }));
  await Promise.all(Array.from({ length: 5 }, () => applyPaidSession(s)));
  assert.equal(
    (await one(pool, "SELECT balance FROM wallets WHERE user_id=$1", [
      other.id,
    ]))!.balance,
    15,
  );
});
test("password reset is single-use and revokes sessions", async () => {
  await send("POST", "/api/v1/auth/forgot-password", { email: other.email });
  const row = await one(
    pool,
    "SELECT j.payload_encrypted FROM auth_tokens t JOIN jobs j ON j.dedup_key='auth:'||t.id::text WHERE user_id=$1 AND purpose='reset' ORDER BY t.expires_at DESC LIMIT 1",
    [other.id],
  );
  const raw = /reset=([A-Za-z0-9_-]+)/.exec(
    unseal<{ text: string }>(row!.payload_encrypted).text,
  )![1]!;
  assert.equal(
    (
      await send("POST", "/api/v1/auth/reset-password", {
        token: raw,
        password: "A-new-secure-password-123",
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await send("GET", "/api/v1/me/dashboard", undefined, other)).statusCode,
    401,
  );
  assert.equal(
    (
      await send("POST", "/api/v1/auth/reset-password", {
        token: raw,
        password: "A-new-secure-password-456",
      })
    ).statusCode,
    400,
  );
});
test("registration requires email verification and stores password hash", async () => {
  const email = `signup-${randomUUID()}@example.test`;
  const r = await send("POST", "/api/v1/registrations", {
    email,
    password,
    firstName: "Nuovo",
    lastName: "Utente",
    birthDate: "1998-01-01",
    privacy: true,
  });
  assert.equal(r.statusCode, 202, r.body);
  assert.equal(
    (await send("POST", "/api/v1/auth/login", { email, password })).statusCode,
    401,
  );
  const u = await one(pool, "SELECT * FROM users WHERE email=$1", [email]);
  assert.notEqual(u!.password_hash, password);
  const row = await one(
    pool,
    "SELECT j.payload_encrypted FROM auth_tokens t JOIN jobs j ON j.dedup_key='auth:'||t.id::text WHERE user_id=$1 AND purpose='verify'",
    [u!.id],
  );
  const raw = /verify=([A-Za-z0-9_-]+)/.exec(
    unseal<{ text: string }>(row!.payload_encrypted).text,
  )![1]!;
  assert.equal(
    (await send("POST", "/api/v1/auth/verify-email", { token: raw }))
      .statusCode,
    200,
  );
  await login(u!.id, email);
});

test("multipart image upload is stored on S3 and returned with temporary signature", async () => {
  const image = await sharp({
    create: { width: 80, height: 80, channels: 3, background: "#abc123" },
  })
    .png()
    .toBuffer();
  const boundary = `boundary${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="number"\r\n\r\n21\r\n--${boundary}\r\nContent-Disposition: form-data; name="word"\r\n\r\nNido\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/associations",
    headers: {
      origin: config.APP_ORIGIN,
      cookie: student.cookie,
      "x-csrf-token": student.csrf,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  assert.equal(response.statusCode, 200, response.body);
  const url = new URL(response.json().image);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
  const stored = await fetch(url);
  assert.equal(stored.status, 200);
  assert.equal(
    (await sharp(Buffer.from(await stored.arrayBuffer())).metadata()).format,
    "webp",
  );
});

test("meeting provisioning sends mandatory recording settings and reads them back", async () => {
  const { provisionMeeting } = await import("../src/zoom.js");
  const response = await send(
    "POST",
    "/api/v1/bookings",
    await slot(20),
    student,
  );
  assert.equal(response.statusCode, 202, response.body);
  const id = response.json().id;
  const original = globalThis.fetch;
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  const meeting = {
    id: `${Date.now()}`,
    uuid: randomUUID(),
    join_url: "https://us02web.zoom.us/j/test",
    settings: { auto_recording: "cloud", join_before_host: false },
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return url.startsWith("https://zoom.us/oauth/token")
      ? Response.json({ access_token: "mock-provider-token", expires_in: 3600 })
      : Response.json(meeting);
  };
  try {
    await provisionMeeting(id);
  } finally {
    globalThis.fetch = original;
  }
  const create = calls.find((c) => c.url.endsWith("/meetings") && c.body)!;
  assert.ok(create);
  const settings = create.body!.settings as Record<string, unknown>;
  assert.equal(settings.auto_recording, "cloud");
  assert.equal(settings.join_before_host, false);
  assert.ok(calls.some((c) => c.url.endsWith(`/meetings/${meeting.id}`)));
  assert.equal(
    (await one(pool, "SELECT status FROM bookings WHERE id=$1", [id]))!.status,
    "READY",
  );
});
test("expired OTP never creates legal consent", async () => {
  const id = randomUUID();
  const { otpHash, seal } = await import("../src/security.js");
  await pool.query(
    "INSERT INTO parent_challenges(id,student_id,guardian_encrypted,otp_hash,legal_version,expires_at) VALUES($1,$2,$3,$4,$5,now()-interval '1 minute')",
    [
      id,
      minor.id,
      seal({ email: "expired@example.test" }),
      otpHash(id, "123456"),
      LEGAL_VERSION,
    ],
  );
  assert.equal(
    (
      await send("POST", `/api/v1/registrations/${id}/verify-parent`, {
        code: "123456",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await one(
      pool,
      "SELECT count(*)::int AS n FROM legal_consents WHERE challenge_id=$1",
      [id],
    ))!.n,
    0,
  );
});
test("unavailable recording does not consume credits", async () => {
  const b = await one(
    pool,
    "SELECT id FROM bookings WHERE student_id=$1 LIMIT 1",
    [minor.id],
  );
  const record = await one(
    pool,
    "INSERT INTO recordings(booking_id,zoom_file_id) VALUES($1,$2) RETURNING id",
    [b!.id, randomUUID()],
  );
  const before = (await one(
    pool,
    "SELECT balance FROM wallets WHERE user_id=$1",
    [minor.id],
  ))!.balance;
  assert.equal(
    (await send("POST", `/api/v1/recordings/${record!.id}/unlock`, {}, minor))
      .statusCode,
    409,
  );
  assert.equal(
    (await one(pool, "SELECT balance FROM wallets WHERE user_id=$1", [
      minor.id,
    ]))!.balance,
    before,
  );
});

test("Redis rate limiting remains active and ignores spoofed forwarded IPs", async () => {
  const ip = `192.0.2.${randomInt(1, 254)}`;
  let response;
  for (let i = 0; i < 121; i++)
    response = await app.inject({
      method: "GET",
      url: "/health/live",
      remoteAddress: ip,
      headers: { "x-forwarded-for": `10.1.1.${(i % 240) + 1}` },
    });
  assert.equal(response!.statusCode, 429);
});

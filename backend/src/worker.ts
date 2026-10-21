import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { pool, one, tx } from "./db.js";
import { unseal } from "./security.js";
import { config } from "./config.js";
import { provisionMeeting, importZoomEvent } from "./zoom.js";
const mail = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE === "true",
  ...(config.SMTP_USER
    ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } }
    : {}),
  connectionTimeout: 15000,
  socketTimeout: 30000,
});
let stopped = false;
process.on("SIGTERM", () => (stopped = true));
process.on("SIGINT", () => (stopped = true));
async function work() {
  const lease = randomUUID();
  const job = await tx(async (db) =>
    one(
      db,
      `UPDATE jobs SET status='RUNNING',attempts=attempts+1,lease_until=now()+interval '2 minutes',lease_token=$1 WHERE id=(SELECT id FROM jobs WHERE (status='PENDING' AND available_at<=now()) OR (status='RUNNING' AND lease_until<now()) ORDER BY available_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
      [lease],
    ),
  );
  if (!job) return false;
  const heartbeat = setInterval(() => {
    pool
      .query(
        "UPDATE jobs SET lease_until=now()+interval '2 minutes' WHERE id=$1 AND lease_token=$2 AND status='RUNNING'",
        [job.id, lease],
      )
      .catch(() => console.error("Worker lease renewal failed"));
  }, 30000);
  try {
    const payload = unseal<Record<string, unknown>>(job.payload_encrypted);
    if (job.kind === "EMAIL") {
      await mail.sendMail({
        from: config.MAIL_FROM,
        to: String(payload.to),
        subject: String(payload.subject),
        text: String(payload.text),
        messageId: `<${job.id}@radice.local>`,
      });
    } else if (job.kind === "ZOOM_CREATE")
      await provisionMeeting(String(payload.bookingId));
    else if (job.kind === "ZOOM_IMPORT") await importZoomEvent(payload);
    await pool.query(
      "UPDATE jobs SET status='DONE',payload_encrypted=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2",
      [job.id, lease],
    );
  } catch (error) {
    const final = job.attempts >= 8; // Avoid leaking SMTP recipients, download URLs or tokens into logs.
    const code = error instanceof Error ? error.name : "JobError";
    await pool.query(
      "UPDATE jobs SET status=$3,last_error=$4,available_at=now()+($5*interval '1 second'),lease_until=NULL WHERE id=$1 AND lease_token=$2",
      [
        job.id,
        lease,
        final ? "FAILED" : "PENDING",
        `${job.kind}:${code}`,
        Math.min(3600, 2 ** job.attempts * 10),
      ],
    );
    if (final && job.kind === "ZOOM_CREATE") {
      const payload = unseal<{ bookingId: string }>(job.payload_encrypted);
      await pool.query(
        "UPDATE bookings SET status='ACTION_REQUIRED' WHERE id=$1 AND zoom_meeting_id IS NULL",
        [payload.bookingId],
      );
    }
    console.error(
      JSON.stringify({
        jobId: job.id,
        kind: job.kind,
        attempt: job.attempts,
        failed: final,
        error: code,
      }),
    );
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
try {
  while (!stopped) {
    try {
      if (!(await work())) await new Promise((r) => setTimeout(r, 1000));
    } catch {
      console.error("Worker database operation failed");
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
} finally {
  mail.close();
  await pool.end();
}

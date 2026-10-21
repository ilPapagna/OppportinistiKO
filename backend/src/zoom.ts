import { createHmac } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { config } from "./config.js";
import { pool, one, tx } from "./db.js";
import { equal, hash, HttpError } from "./security.js";
import { enqueue } from "./jobs.js";
import { importVideo } from "./storage.js";
let access: { value: string; expires: number } | undefined;
async function accessToken() {
  if (access && access.expires > Date.now() + 60000) return access.value;
  if (
    !config.ZOOM_ACCOUNT_ID ||
    !config.ZOOM_CLIENT_ID ||
    !config.ZOOM_CLIENT_SECRET
  )
    throw new Error("Zoom credentials missing");
  const url = new URL("https://zoom.us/oauth/token");
  url.searchParams.set("grant_type", "account_credentials");
  url.searchParams.set("account_id", config.ZOOM_ACCOUNT_ID);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.ZOOM_CLIENT_ID}:${config.ZOOM_CLIENT_SECRET}`).toString("base64")}`,
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Zoom OAuth HTTP ${response.status}`);
  const result = z
    .object({ access_token: z.string(), expires_in: z.number() })
    .parse(await response.json());
  access = {
    value: result.access_token,
    expires: Date.now() + result.expires_in * 1000,
  };
  return access.value;
}
async function zoom(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`https://api.zoom.us/v2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Zoom API HTTP ${response.status}`);
  return response.json();
}
const meetingSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  uuid: z.string(),
  join_url: z.url(),
  settings: z.object({
    auto_recording: z.string(),
    join_before_host: z.boolean(),
  }),
});
export async function provisionMeeting(bookingId: string) {
  const booking = await one(
    pool,
    "SELECT b.*,s.starts_at,t.zoom_user_id FROM bookings b JOIN tutor_slots s ON s.id=b.slot_id JOIN users t ON t.id=s.tutor_id WHERE b.id=$1",
    [bookingId],
  );
  if (!booking) throw new Error("Booking not found");
  if (booking.zoom_meeting_id) return;
  const marker = `Radice ${bookingId}`;
  let candidate: unknown;
  const first = await one(
    pool,
    "UPDATE bookings SET creation_started_at=now() WHERE id=$1 AND creation_started_at IS NULL RETURNING id",
    [bookingId],
  );
  if (first) {
    candidate = await zoom(
      `/users/${encodeURIComponent(booking.zoom_user_id)}/meetings`,
      "POST",
      {
        topic: marker,
        agenda: `Lezione individuale Radice. Riferimento ${bookingId}`,
        type: 2,
        start_time: new Date(booking.starts_at).toISOString(),
        duration: 60,
        timezone: "Europe/Rome",
        settings: {
          auto_recording: "cloud",
          join_before_host: false,
          waiting_room: true,
          approval_type: 2,
          mute_upon_entry: true,
          allow_multiple_devices: false,
        },
      },
    );
  } else {
    // A network timeout after POST is ambiguous. Reconcile; never blindly create a second meeting.
    let pageToken = "";
    let found: { id: string | number } | undefined;
    for (let page = 0; page < 20; page++) {
      const result = (await zoom(
        `/users/${encodeURIComponent(booking.zoom_user_id)}/meetings?type=scheduled&page_size=300${pageToken ? `&next_page_token=${encodeURIComponent(pageToken)}` : ""}`,
      )) as {
        meetings: { id: string | number; topic: string }[];
        next_page_token?: string;
      };
      found = result.meetings.find((m) => m.topic === marker);
      if (found || !result.next_page_token) break;
      pageToken = result.next_page_token;
    }
    if (!found) {
      await pool.query(
        "UPDATE bookings SET status='ACTION_REQUIRED' WHERE id=$1",
        [bookingId],
      );
      throw new Error(
        "Ambiguous Zoom creation; operator reconciliation required",
      );
    }
    candidate = await zoom(`/meetings/${found.id}`);
  }
  const meeting = meetingSchema.parse(candidate);
  // Read back effective settings, including account-level restrictions.
  const actual = meetingSchema.parse(await zoom(`/meetings/${meeting.id}`));
  if (
    actual.settings.auto_recording !== "cloud" ||
    actual.settings.join_before_host !== false
  ) {
    await pool.query(
      "UPDATE bookings SET status='ACTION_REQUIRED' WHERE id=$1",
      [bookingId],
    );
    throw new Error("Mandatory Zoom recording settings not effective");
  }
  if (new URL(actual.join_url).protocol !== "https:")
    throw new Error("Invalid Zoom join URL");
  await pool.query(
    "UPDATE bookings SET zoom_meeting_id=$2,zoom_uuid=$3,join_url=$4,status='READY' WHERE id=$1",
    [bookingId, actual.id, actual.uuid, actual.join_url],
  );
}
export function verifyZoomSignature(
  raw: string,
  timestamp: string,
  signature: string,
  secret: string,
  now = Date.now(),
) {
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
  return equal(expected, signature);
}
export function zoomDownloadURL(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    !(url.hostname === "zoom.us" || url.hostname.endsWith(".zoom.us"))
  )
    throw new Error("Untrusted Zoom recording URL");
  return url;
}
export async function downloadRecording(
  recordingId: string,
  downloadUrl: string,
  downloadToken?: string,
) {
  const record = await one(pool, "SELECT * FROM recordings WHERE id=$1", [
    recordingId,
  ]);
  if (!record || record.status === "READY") return;
  let url = zoomDownloadURL(downloadUrl);
  let response: Response | undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15 * 60 * 1000);
  try {
    for (let redirects = 0; redirects < 5; redirects++) {
      response = await fetch(url, {
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${downloadToken || (await accessToken())}`,
        },
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("Invalid Zoom redirect");
        url = zoomDownloadURL(new URL(location, url).href);
        continue;
      }
      break;
    }
    if (!response?.ok || !response.body)
      throw new Error(`Zoom recording download HTTP ${response?.status}`);
    const size = Number(response.headers.get("content-length"));
    if (size > 2 * 1024 ** 3) throw new Error("Recording exceeds 2 GiB");
    const storageKey = `recordings/${record.booking_id}/${record.id}.mp4`;
    await importVideo(storageKey, response.body);
    await tx(async (db) => {
      await db.query(
        "UPDATE recordings SET status='READY',storage_key=$2 WHERE id=$1",
        [recordingId, storageKey],
      );
      await db.query("UPDATE bookings SET status='COMPLETED' WHERE id=$1", [
        record.booking_id,
      ]);
    });
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
const completed = z.object({
  event: z.literal("recording.completed"),
  event_ts: z.number(),
  download_token: z.string().optional(),
  payload: z.object({
    account_id: z.string(),
    object: z.object({
      id: z.union([z.number(), z.string()]).transform(String),
      uuid: z.string(),
      recording_files: z
        .array(
          z.object({
            id: z.string(),
            file_type: z.string(),
            status: z.string(),
            download_url: z.url(),
            recording_type: z.string().optional(),
          }),
        )
        .max(100),
    }),
  }),
});
export async function importZoomEvent(input: unknown) {
  const event = completed.parse(input);
  const meeting = event.payload.object;
  const booking = await one(
    pool,
    "SELECT id FROM bookings WHERE zoom_meeting_id=$1",
    [meeting.id],
  );
  if (!booking) throw new Error("Booking not linked yet; retry event");
  const files = meeting.recording_files.filter(
    (f) => f.status === "completed" && f.file_type === "MP4",
  );
  if (!files.length) throw new Error("No completed MP4 recording");
  // Pick a single canonical layout; multiple layouts must not cost additional unlocks.
  const file =
    files.find((f) => f.recording_type === "shared_screen_with_speaker_view") ||
    files[0]!;
  zoomDownloadURL(file.download_url);
  const record = await one(
    pool,
    "INSERT INTO recordings(booking_id,zoom_file_id) VALUES($1,$2) ON CONFLICT(zoom_file_id) DO UPDATE SET zoom_file_id=EXCLUDED.zoom_file_id RETURNING id",
    [booking.id, file.id],
  );
  await downloadRecording(record!.id, file.download_url, event.download_token);
}
export async function zoomRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/webhooks/zoom",
    {
      config: {
        public: true,
        webhook: true,
        rawBody: true,
        rateLimit: { max: 1000, timeWindow: "1 minute" },
      },
    },
    async (request) => {
      if (!config.ZOOM_WEBHOOK_SECRET)
        throw new HttpError(503, "Zoom non configurato");
      const raw = request.rawBody;
      if (typeof raw !== "string") throw new HttpError(400, "Missing raw body");
      const timestamp = request.headers["x-zm-request-timestamp"],
        signature = request.headers["x-zm-signature"];
      if (
        typeof timestamp !== "string" ||
        typeof signature !== "string" ||
        !verifyZoomSignature(
          raw,
          timestamp,
          signature,
          config.ZOOM_WEBHOOK_SECRET,
        )
      )
        throw new HttpError(401, "Firma webhook non valida");
      const basic = z
        .object({
          event: z.string(),
          payload: z.record(z.string(), z.unknown()),
        })
        .parse(request.body);
      if (basic.event === "endpoint.url_validation") {
        const plain = z
          .string()
          .min(1)
          .max(1000)
          .parse(basic.payload.plainToken);
        return {
          plainToken: plain,
          encryptedToken: createHmac("sha256", config.ZOOM_WEBHOOK_SECRET)
            .update(plain)
            .digest("hex"),
        };
      }
      if (basic.event !== "recording.completed") return { received: true };
      const event = completed.parse(request.body);
      if (event.payload.account_id !== config.ZOOM_ACCOUNT_ID)
        throw new HttpError(403, "Account Zoom non autorizzato");
      const eventId = hash(
        `${event.event}:${event.payload.object.uuid}:${event.payload.object.recording_files
          .map((f) => f.id)
          .sort()
          .join(",")}`,
      );
      await tx(async (db) => {
        const inserted = await db.query(
          "INSERT INTO webhook_events(provider,event_id) VALUES('zoom',$1) ON CONFLICT DO NOTHING RETURNING event_id",
          [eventId],
        );
        if (inserted.rowCount)
          await enqueue(db, "ZOOM_IMPORT", `zoom-event:${eventId}`, event);
      });
      return { received: true };
    },
  );
}

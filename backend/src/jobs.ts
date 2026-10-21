import type { DB } from "./db.js";
import { seal } from "./security.js";
export async function enqueue(
  db: DB,
  kind: "EMAIL" | "ZOOM_CREATE" | "ZOOM_IMPORT",
  key: string,
  payload: unknown,
) {
  await db.query(
    "INSERT INTO jobs(kind,dedup_key,payload_encrypted) VALUES($1,$2,$3) ON CONFLICT(dedup_key) DO NOTHING",
    [kind, key, seal(payload)],
  );
}

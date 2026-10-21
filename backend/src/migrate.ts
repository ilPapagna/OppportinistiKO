import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";
const db = await pool.connect();
try {
  await db.query("SELECT pg_advisory_lock(731284)");
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  for (const file of (await readdir(directory))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (
      (await db.query("SELECT 1 FROM schema_migrations WHERE name=$1", [file]))
        .rowCount
    )
      continue;
    await db.query("BEGIN");
    try {
      await db.query(await readFile(`${directory}/${file}`, "utf8"));
      await db.query("INSERT INTO schema_migrations(name) VALUES($1)", [file]);
      await db.query("COMMIT");
      console.log(`Applied ${file}`);
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await db.query("SELECT pg_advisory_unlock(731284)");
  db.release();
  await pool.end();
}

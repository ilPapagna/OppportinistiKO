import pg, { type PoolClient, type QueryResultRow } from "pg";
import { config } from "./config.js";
// PostgreSQL date values remain calendar dates, never JS timezone conversions.
pg.types.setTypeParser(1082, (value) => value);
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
});
pool.on("error", () => console.error("PostgreSQL idle connection error"));
export type DB = Pick<PoolClient, "query">;
export async function one<T extends QueryResultRow = QueryResultRow>(
  db: DB,
  sql: string,
  args: unknown[] = [],
): Promise<T | undefined> {
  return (await db.query<T>(sql, args)).rows[0];
}
export async function tx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL lock_timeout='5s'");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}

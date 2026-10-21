import { type DB, one } from "./db.js";
import { hash, HttpError } from "./security.js";
export async function moveCredits(
  db: DB,
  userId: string,
  delta: number,
  kind: string,
  reference: string,
  idempotencyKey: string,
  actorId: string | null = null,
) {
  const fingerprint = hash(JSON.stringify({ delta, kind, reference }));
  const wallet = await one(
    db,
    "SELECT balance FROM wallets WHERE user_id=$1 FOR UPDATE",
    [userId],
  );
  if (!wallet) throw new HttpError(404, "Portafoglio non trovato");
  const previous = await one(
    db,
    "SELECT * FROM credit_transactions WHERE user_id=$1 AND idempotency_key=$2",
    [userId, idempotencyKey],
  );
  if (previous) {
    if (previous.request_hash !== fingerprint)
      throw new HttpError(
        409,
        "Chiave di idempotenza già utilizzata per una richiesta diversa",
      );
    return previous;
  }
  const next = wallet.balance + delta;
  if (next < 0) throw new HttpError(409, "Crediti insufficienti");
  if (!Number.isSafeInteger(next) || next > 2147483647)
    throw new HttpError(400, "Saldo non valido");
  await db.query("UPDATE wallets SET balance=$2 WHERE user_id=$1", [
    userId,
    next,
  ]);
  return (
    await db.query(
      "INSERT INTO credit_transactions(user_id,delta,balance_after,kind,reference,idempotency_key,request_hash,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [
        userId,
        delta,
        next,
        kind,
        reference,
        idempotencyKey,
        fingerprint,
        actorId,
      ],
    )
  ).rows[0];
}

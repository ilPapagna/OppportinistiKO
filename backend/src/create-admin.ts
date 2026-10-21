import { z } from "zod";
import { tx, pool, one } from "./db.js";
import { passwordHash } from "./security.js";
import { password, email } from "./auth.js";
const input = z
  .object({ ADMIN_EMAIL: email, ADMIN_PASSWORD: password })
  .parse(process.env);
try {
  const secret = await passwordHash(input.ADMIN_PASSWORD);
  await tx(async (db) => {
    const user = await one(
      db,
      "INSERT INTO users(email,first_name,last_name,birth_date,password_hash,role,email_verified_at) VALUES($1,'Amministratore','Radice','1990-01-01',$2,'ADMIN',now()) RETURNING id",
      [input.ADMIN_EMAIL, secret],
    );
    await db.query("INSERT INTO wallets(user_id) VALUES($1)", [user!.id]);
  });
  console.log(
    "Amministratore creato. Conservare le credenziali in modo sicuro.",
  );
} finally {
  await pool.end();
}

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const random = () => randomBytes(32).toString("hex");
const env = `# Generated local secrets. Never commit this file.\nPOSTGRES_PASSWORD=${random()}\nDATA_KEY=${random()}\nOTP_PEPPER=${random()}\nS3_ACCESS_KEY=radice-local\nS3_SECRET_KEY=${random()}\nAPP_ORIGIN=http://localhost:3000\n`;
await writeFile(new URL("../.env", import.meta.url), env, {
  flag: "wx",
  mode: 0o600,
});
console.log("Created backend/.env without overwriting existing configuration.");

// Run development commands against Docker dependencies without printing secrets.
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const contents = await readFile(new URL("../.env", import.meta.url), "utf8");
const values = Object.fromEntries(
  contents
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const testing = process.argv[2] === "--test";
const args = process.argv.slice(testing ? 3 : 2);
if (!args.length) throw new Error("Provide a command");
const env = {
  ...process.env,
  ...values,
  NODE_ENV: testing ? "test" : "development",
  DATABASE_URL: `postgresql://radice:${values.POSTGRES_PASSWORD}@127.0.0.1:5432/${testing ? "radice_test" : "radice"}`,
  REDIS_URL: `redis://127.0.0.1:6379/${testing ? 1 : 0}`,
  APP_ORIGIN: values.APP_ORIGIN || "http://localhost:3000",
  COOKIE_SECURE: "false",
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: "1025",
  SMTP_SECURE: "false",
  S3_BUCKET: "radice-private",
  S3_REGION: "eu-west-1",
  S3_ENDPOINT: "http://localhost:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_FORCE_PATH_STYLE: "true",
};
if (testing) {
  env.ZOOM_ACCOUNT_ID = "test-account";
  env.ZOOM_CLIENT_ID = "test-client";
  env.ZOOM_CLIENT_SECRET = "test-secret";
  env.ZOOM_WEBHOOK_SECRET = "test-webhook-secret";
}
const child = spawn(args[0], args.slice(1), { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));

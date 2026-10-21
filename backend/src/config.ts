import { z } from "zod";
const env = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    APP_ORIGIN: z.url(),
    DATA_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
    OTP_PEPPER: z.string().min(32),
    COOKIE_SECURE: z.enum(["true", "false"]).default("true"),
    TRUST_PROXY: z.string().optional(),
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().default(1025),
    SMTP_SECURE: z.enum(["true", "false"]).default("false"),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    MAIL_FROM: z.string().default("Radice <noreply@radice.test>"),
    S3_BUCKET: z.string().min(1),
    S3_REGION: z.string().default("eu-west-1"),
    S3_ENDPOINT: z.url().optional(),
    S3_PUBLIC_ENDPOINT: z.url().optional(),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
    ZOOM_ACCOUNT_ID: z.string().optional(),
    ZOOM_CLIENT_ID: z.string().optional(),
    ZOOM_CLIENT_SECRET: z.string().optional(),
    ZOOM_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  })
  .parse(process.env);
if (
  env.NODE_ENV === "production" &&
  (env.COOKIE_SECURE !== "true" || !env.APP_ORIGIN.startsWith("https:"))
)
  throw new Error("Production requires HTTPS and secure cookies");
export const config = env;

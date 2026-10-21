import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import rawBody from "fastify-raw-body";
import { Redis } from "ioredis";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { config } from "./config.js";
import { pool } from "./db.js";
import { HttpError } from "./security.js";
import { authPlugin } from "./auth.js";
import { studentRoutes } from "./student.js";
import { zoomRoutes } from "./zoom.js";
import { paymentRoutes } from "./payments.js";
import { adminRoutes } from "./admin.js";
export async function buildApp() {
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  redis.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    if (redis.status === "ready") resolve();
    else {
      redis.once("ready", resolve);
      redis.once("error", reject);
    }
  });
  const app = Fastify({
    trustProxy: config.TRUST_PROXY ? config.TRUST_PROXY.split(",") : false,
    bodyLimit: 512 * 1024,
    requestTimeout: 30000,
    logger:
      config.NODE_ENV === "test"
        ? false
        : {
            level: "info",
            redact: [
              "req.headers.cookie",
              "req.headers.authorization",
              'req.headers["x-csrf-token"]',
              "req.body",
              'res.headers["set-cookie"]',
            ],
            serializers: {
              req: (r) => ({
                method: r.method,
                url: r.url?.split("?")[0],
                id: r.id,
              }),
            },
          },
  });
  await app.register(cookie);
  await app.register(cors, { origin: config.APP_ORIGIN, credentials: true });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: [
          "'self'",
          "data:",
          ...(config.S3_PUBLIC_ENDPOINT || config.S3_ENDPOINT
            ? [
                new URL((config.S3_PUBLIC_ENDPOINT || config.S3_ENDPOINT)!)
                  .origin,
              ]
            : [
                `https://${config.S3_BUCKET}.s3.${config.S3_REGION}.amazonaws.com`,
              ]),
        ],
        mediaSrc: [
          "'self'",
          ...(config.S3_PUBLIC_ENDPOINT || config.S3_ENDPOINT
            ? [
                new URL((config.S3_PUBLIC_ENDPOINT || config.S3_ENDPOINT)!)
                  .origin,
              ]
            : [
                `https://${config.S3_BUCKET}.s3.${config.S3_REGION}.amazonaws.com`,
              ]),
        ],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.NODE_ENV === "production" ? [] : null,
      },
    },
  });
  await app.register(rateLimit, {
    redis,
    max: 120,
    timeWindow: "1 minute",
    skipOnError: false,
  });
  await app.register(multipart, {
    limits: {
      fileSize: 200 * 1024,
      files: 1,
      fields: 3,
      fieldSize: 1000,
      parts: 4,
    },
    throwFileSizeLimit: true,
  });
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        message: "Dati non validi",
        fields: error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    const pgError = error as { code?: string; statusCode?: number };
    if (["23505", "23P01"].includes(pgError.code || ""))
      return reply
        .code(409)
        .send({ message: "Operazione in conflitto con dati già presenti" });
    if (error instanceof HttpError)
      return reply.code(error.statusCode).send({ message: error.message });
    if (pgError.statusCode && pgError.statusCode < 500)
      return reply.code(pgError.statusCode).send({
        message:
          pgError.statusCode === 413
            ? "File o richiesta troppo grande"
            : "Richiesta non valida",
      });
    request.log.error(
      {
        errorType: error instanceof Error ? error.name : "Unknown",
        code: pgError.code,
      },
      "Request failed",
    );
    return reply
      .code(500)
      .send({ message: "Errore interno", requestId: request.id });
  });
  await authPlugin(app);
  app.get("/health/live", { config: { public: true } }, async () => ({
    status: "ok",
  }));
  app.get("/health/ready", { config: { public: true } }, async () => {
    await pool.query("SELECT 1");
    await redis.ping();
    return { status: "ready" };
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/"))
      reply.header("Cache-Control", "no-store");
    return payload;
  });
  await studentRoutes(app);
  await zoomRoutes(app);
  await paymentRoutes(app);
  await app.register(adminRoutes, { prefix: "/api/v1/admin" });
  const publicFiles: Record<string, [string, string]> = {
    "/admin": ["../public/admin.html", "text/html"],
    "/account": ["../public/account.html", "text/html"],
    "/admin.js": ["../public/admin.js", "text/javascript"],
    "/account.js": ["../public/account.js", "text/javascript"],
    "/backoffice.css": ["../public/backoffice.css", "text/css"],
  };
  for (const [url, [file, type]] of Object.entries(publicFiles))
    app.get(url, { config: { public: true } }, async (_, reply) =>
      reply
        .type(type)
        .send(
          await readFile(fileURLToPath(new URL(file, import.meta.url)), "utf8"),
        ),
    );
  app.get(
    "/runtime-config.js",
    { config: { public: true } },
    async (_, reply) =>
      reply
        .type("text/javascript")
        .send("window.RADICE_CONFIG={demo:false,baseUrl:'/api/v1'};"),
  );
  const siteRoot = fileURLToPath(new URL("../../", import.meta.url));
  app.get("/", { config: { public: true } }, async (_, reply) => {
    let html = await readFile(`${siteRoot}/index.html`, "utf8");
    html = html.replace(
      '<script type="module"',
      '<script src="/runtime-config.js"></script><script type="module"',
    );
    return reply.type("text/html").send(html);
  });
  for (const [url, file, type] of [
    ["/styles.css", "styles.css", "text/css"],
    ["/js/app.js", "js/app.js", "text/javascript"],
    ["/js/api.js", "js/api.js", "text/javascript"],
    ["/js/utils.js", "js/utils.js", "text/javascript"],
    ["/assets/study.svg", "assets/study.svg", "image/svg+xml"],
  ])
    app.get(url!, { config: { public: true } }, async (_, reply) =>
      reply.type(type!).send(await readFile(`${siteRoot}/${file}`, "utf8")),
    );
  app.addHook("onClose", async () => {
    await redis.quit();
  });
  return app;
}

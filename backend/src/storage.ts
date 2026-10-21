import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable, Transform } from "node:stream";
import sharp from "sharp";
import { config } from "./config.js";
import { HttpError } from "./security.js";
export const s3 = new S3Client({
  region: config.S3_REGION,
  endpoint: config.S3_ENDPOINT,
  forcePathStyle: config.S3_FORCE_PATH_STYLE === "true",
  ...(config.S3_ACCESS_KEY && config.S3_SECRET_KEY
    ? {
        credentials: {
          accessKeyId: config.S3_ACCESS_KEY,
          secretAccessKey: config.S3_SECRET_KEY,
        },
      }
    : {}),
});
const signingClient = config.S3_PUBLIC_ENDPOINT
  ? new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_PUBLIC_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE === "true",
      ...(config.S3_ACCESS_KEY && config.S3_SECRET_KEY
        ? {
            credentials: {
              accessKeyId: config.S3_ACCESS_KEY,
              secretAccessKey: config.S3_SECRET_KEY,
            },
          }
        : {}),
    })
  : s3;
export const signed = (key: string) =>
  getSignedUrl(
    signingClient,
    new GetObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      ResponseCacheControl: "private, no-store",
    }),
    { expiresIn: 300 },
  );
export const remove = (key: string) =>
  s3.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
export async function validateImage(input: Buffer) {
  if (input.length > 200 * 1024)
    throw new HttpError(413, "Immagine superiore a 200 KB");
  try {
    const pipeline = sharp(input, {
      limitInputPixels: 16_000_000,
      failOn: "warning",
    });
    const meta = await pipeline.metadata();
    if (
      !["jpeg", "png", "webp"].includes(meta.format || "") ||
      (meta.pages || 1) > 1
    )
      throw new Error("format");
    const output = await pipeline
      .rotate()
      .resize({
        width: 1400,
        height: 1400,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer();
    if (output.length > 200 * 1024)
      throw new HttpError(413, "Immagine ricodificata troppo grande");
    return output;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(
      400,
      "Immagine non valida: usa JPEG, PNG o WebP statico",
    );
  }
}
export async function putImage(key: string, input: Buffer) {
  await s3.send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      Body: input,
      ContentType: "image/webp",
      CacheControl: "private, no-store",
    }),
  );
}
export async function importVideo(
  key: string,
  body: ReadableStream<Uint8Array>,
) {
  let count = 0;
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      count += chunk.length;
      if (count > 2 * 1024 ** 3) callback(new Error("Recording exceeds 2 GiB"));
      else callback(null, chunk);
    },
  });
  const stream = Readable.fromWeb(
    body as Parameters<typeof Readable.fromWeb>[0],
  );
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: config.S3_BUCKET,
      Key: key,
      Body: stream.pipe(limit),
      ContentType: "video/mp4",
      CacheControl: "private, no-store",
    },
    queueSize: 2,
    partSize: 8 * 1024 ** 2,
    leavePartsOnError: false,
  });
  stream.on("error", (e) => limit.destroy(e));
  try {
    await upload.done();
  } finally {
    stream.destroy();
    limit.destroy();
  }
}

import {
  randomBytes,
  scrypt as rawScrypt,
  timingSafeEqual,
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { config } from "./config.js";
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    rawScrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 ** 2 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
export const token = () => randomBytes(32).toString("base64url");
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const otpHash = (id: string, code: string) =>
  createHmac("sha256", config.OTP_PEPPER).update(`${id}:${code}`).digest("hex");
export function equal(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt);
  return `scrypt-v1:${salt}:${key.toString("hex")}`;
}
export async function passwordVerify(password: string, stored: string) {
  const [version, salt, key] = stored.split(":");
  if (version !== "scrypt-v1" || !salt || !key) return false;
  return equal((await derive(password, salt)).toString("hex"), key);
}
export function seal(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(config.DATA_KEY, "hex"),
    iv,
  );
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}
export function unseal<T>(value: string): T {
  const [version, iv, tag, data] = value.split(".");
  if (version !== "v1" || !iv || !tag || !data)
    throw new Error("Invalid encrypted payload");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(config.DATA_KEY, "hex"),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]).toString("utf8"),
  ) as T;
}
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export const assert = (
  condition: unknown,
  status: number,
  message: string,
): asserts condition => {
  if (!condition) throw new HttpError(status, message);
};
export function isMinor(birthDate: string, at = new Date()) {
  const today = at.toISOString().slice(0, 10);
  const birthday = `${Number(today.slice(0, 4)) - 18}${today.slice(4)}`;
  return birthDate > birthday;
}

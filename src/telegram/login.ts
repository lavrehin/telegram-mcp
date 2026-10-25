/**
 * Telegram Login verification (core.telegram.org/widgets/login#checking-authorization).
 *
 * The data-check-string is every field but `hash`, sorted by key, as
 * `key=value` lines; the hash is its HMAC-SHA-256 under SHA-256(bot token).
 */

import { bytesToHex, hmac, nowSeconds, timingSafeEqual } from "../crypto";

export interface LoginUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  auth_date: number;
}

/** A login older than this is refused, so a captured one cannot be replayed later. */
const LOGIN_MAX_AGE_SECONDS = 10 * 60;

export async function verifyLogin(
  data: Record<string, unknown>,
  loginKey: CryptoKey,
): Promise<LoginUser | null> {
  const { hash, ...fields } = data;
  if (typeof hash !== "string") return null;

  const checkString = Object.keys(fields)
    .filter((key) => fields[key] !== undefined && fields[key] !== null)
    .sort()
    .map((key) => `${key}=${String(fields[key])}`)
    .join("\n");

  const expected = bytesToHex(await hmac(loginKey, checkString));
  if (!timingSafeEqual(expected, hash.toLowerCase())) return null;

  const id = Number(fields.id);
  const authDate = Number(fields.auth_date);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(authDate)) return null;

  const age = nowSeconds() - authDate;
  if (age > LOGIN_MAX_AGE_SECONDS || age < -60) return null;

  const text = (key: string) => (typeof fields[key] === "string" ? fields[key] : undefined);
  return {
    id,
    first_name: text("first_name"),
    last_name: text("last_name"),
    username: text("username"),
    auth_date: authDate,
  };
}

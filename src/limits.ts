/**
 * Rate limits.
 *
 * Cloudflare's rate limit binding needs nothing provisioned — the namespaces
 * live in `wrangler.jsonc` alone. Counting is **per-colo**, not global, and the
 * window is 10 or 60 seconds, so this is a ceiling on abuse, not a guarantee.
 *
 * Everything fails open: a missing binding or a limiter that throws lets the
 * request through. The webhook is not limited at all — it is gated by
 * Telegram's IP ranges and the secret token, and refusing Telegram only makes
 * it retry.
 */

import { sha256Base64Url } from "./crypto";

/** Every caller Cloudflare gave no IP for shares this one, rather than a key of "". */
const UNKNOWN_IP = "unknown-ip";

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || UNKNOWN_IP;
}

/** A rate-limit key that does not carry the bearer token itself. */
export function tokenKey(token: string): Promise<string> {
  return sha256Base64Url(token);
}

/** Whether the request may proceed. */
export async function allow(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return true;
  }
}

/** Seconds a refused caller is told to wait — one full window. */
const RETRY_AFTER_SECONDS = 60;

export const RETRY_AFTER_HEADERS = { "retry-after": String(RETRY_AFTER_SECONDS) };

export function tooManyRequests(message: string): Response {
  return new Response(`${message}\n`, {
    status: 429,
    headers: { "content-type": "text/plain; charset=utf-8", ...RETRY_AFTER_HEADERS },
  });
}

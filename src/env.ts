/**
 * Configuration.
 *
 * A deployment is configured by one secret, `BOT_TOKEN`. Every other key is
 * derived from it, so there is nothing else to generate, store or leak — and
 * rotating the token in @BotFather invalidates every session at once.
 */

import { aesKey, bytesToHex, hmac, hmacKey, sha256 } from "./crypto";

export interface Env {
  BOT_TOKEN: string;
  /** Comma-separated Telegram user ids. Empty or absent: anyone may connect. */
  ALLOWED_USER_IDS?: string;
  /** Days to keep messages. Default 14. */
  RETENTION_DAYS?: string;
  /** "1" in `.dev.vars` lets local webhook tests in from 127.0.0.1. Never set in production. */
  DEV_SKIP_IP_CHECK?: string;
  DB: D1Database;
  /** /token, /register and the login callback, keyed by client IP. */
  AUTH_LIMIT?: RateLimit;
  /** The MCP endpoint, keyed by user. */
  MCP_LIMIT?: RateLimit;
  /** Upload and download links, keyed by client IP. */
  FILE_LIMIT?: RateLimit;
}

export interface Config {
  botToken: string;
  botId: number;
  /** Null means open to everyone. */
  allowed: Set<number> | null;
  retentionDays: number;
  skipIpCheck: boolean;
  /** Signs every blob the connector issues. */
  signingKey: CryptoKey;
  /** Telegram's login widget signs with SHA-256(bot token) as the HMAC key. */
  loginKey: CryptoKey;
  /** Sent by Telegram as X-Telegram-Bot-Api-Secret-Token on every webhook call. */
  webhookSecret: string;
  /** Encrypts the routine tokens users give the bot (AES-GCM). */
  secretKey: CryptoKey;
}

const DEFAULT_RETENTION_DAYS = 14;

export function parseAllowed(raw: string | undefined): Set<number> | null {
  const ids = (raw ?? "")
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  return ids.length ? new Set(ids) : null;
}

export function isAllowed(config: Pick<Config, "allowed">, userId: number): boolean {
  return config.allowed === null || config.allowed.has(userId);
}

/** One config per token per isolate: key derivation is async and needs doing only once. */
const cache = new Map<string, Promise<Config>>();

export function loadConfig(env: Env): Promise<Config> {
  const cacheKey = [env.BOT_TOKEN, env.ALLOWED_USER_IDS, env.RETENTION_DAYS, env.DEV_SKIP_IP_CHECK]
    .map(String)
    .join("\n");
  let config = cache.get(cacheKey);
  if (!config) {
    config = buildConfig(env);
    cache.set(cacheKey, config);
    config.catch(() => cache.delete(cacheKey));
  }
  return config;
}

async function buildConfig(env: Env): Promise<Config> {
  const botToken = env.BOT_TOKEN?.trim();
  const botId = Number(botToken?.split(":")[0]);
  if (!botToken || !Number.isSafeInteger(botId) || botId <= 0) {
    throw new Error(
      "BOT_TOKEN is missing or malformed. Set it with `wrangler secret put BOT_TOKEN`.",
    );
  }

  const root = await hmacKey(botToken);
  const retention = Number(env.RETENTION_DAYS);

  return {
    botToken,
    botId,
    allowed: parseAllowed(env.ALLOWED_USER_IDS),
    retentionDays:
      Number.isFinite(retention) && retention >= 1 ? Math.floor(retention) : DEFAULT_RETENTION_DAYS,
    skipIpCheck: env.DEV_SKIP_IP_CHECK === "1",
    signingKey: await hmacKey(await hmac(root, "telegram-mcp/sign")),
    loginKey: await hmacKey(await sha256(botToken)),
    webhookSecret: bytesToHex(await hmac(root, "telegram-mcp/webhook")),
    secretKey: await aesKey(await hmac(root, "telegram-mcp/secret")),
  };
}

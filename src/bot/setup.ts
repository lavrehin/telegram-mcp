/**
 * Webhook and command registration.
 *
 * Nothing about this is configured by hand. The first request that reveals
 * the Worker's public URL — someone opening it in a browser, or a connector
 * starting OAuth — registers the webhook, and the daily cron re-checks it.
 * A fingerprint of what was registered sits in `meta`, so a rotated bot token
 * (which changes the secret) or a new update type re-registers by itself.
 */

import { bytesToBase64Url, sha256 } from "../crypto";
import type { Config } from "../env";
import type { Store } from "../store";
import type { TelegramApi } from "../telegram/api";

const ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "my_chat_member",
  "chat_member",
  "callback_query",
  "message_reaction",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
];

export const WEBHOOK_PATH = "/telegram";

// Only /start is advertised: the rest lives in its menu. Groups get no list at
// all — /connect still works there, it just does not crowd the suggestions.
const PRIVATE_COMMANDS = [{ command: "start", description: "Menu and your Telegram ID" }];

const PRIVATE_COMMANDS_RU = [{ command: "start", description: "Меню и твой Telegram ID" }];

/** The last fingerprint this isolate registered, so a warm isolate skips even the D1 read. */
let registered: string | undefined;

async function fingerprint(config: Config, url: string): Promise<string> {
  const material = [url, config.webhookSecret, ALLOWED_UPDATES.join(","), "commands-v2"].join("\n");
  return bytesToBase64Url(await sha256(material));
}

export async function ensureWebhook(
  api: TelegramApi,
  config: Config,
  store: Store,
  origin: string,
): Promise<string> {
  const url = `${origin}${WEBHOOK_PATH}`;
  const wanted = await fingerprint(config, url);
  if (registered === wanted) return origin;

  // The first public origin seen wins. Opening the Worker under another host
  // (a preview URL, a second route) must not move the webhook there; moving
  // it on purpose means deleting `public_origin` from the meta table.
  const bound = await store.getMeta("public_origin");
  if (bound && bound !== origin) return bound;

  if ((await store.getMeta("webhook_fingerprint")) !== wanted) {
    await api.call("setWebhook", {
      url,
      secret_token: config.webhookSecret,
      allowed_updates: ALLOWED_UPDATES,
      max_connections: 40,
    });
    await Promise.all([
      api.call("setMyCommands", {
        commands: PRIVATE_COMMANDS,
        scope: { type: "all_private_chats" },
      }),
      api.call("setMyCommands", {
        commands: PRIVATE_COMMANDS_RU,
        scope: { type: "all_private_chats" },
        language_code: "ru",
      }),
      api.call("deleteMyCommands", { scope: { type: "all_group_chats" } }),
    ]);
    await store.setMeta("webhook_fingerprint", wanted);
  }
  await store.setMeta("public_origin", origin);
  registered = wanted;
  return origin;
}

/** For tests. */
export function resetWebhookCache(): void {
  registered = undefined;
}

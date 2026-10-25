/**
 * Per-request wiring: config, database, Bot API client and bot identity, the
 * same for the webhook, the MCP endpoint and the file links. Everything here
 * is either derived once per isolate (keys, bot identity, schema check) or
 * cheap to build, and nothing request-specific outlives the request.
 */

import { Access } from "./access";
import type { BotContext } from "./bot/context";
import { loadConfig, type Config, type Env } from "./env";
import { ensureSchema } from "./schema";
import { Store } from "./store";
import { botIdentity, TelegramApi } from "./telegram/api";
import type { ToolContext } from "./tools/common";

export interface Base {
  config: Config;
  store: Store;
  api: TelegramApi;
}

export async function base(env: Env): Promise<Base> {
  const config = await loadConfig(env);
  await ensureSchema(env.DB);
  return { config, store: new Store(env.DB), api: new TelegramApi(config.botToken) };
}

export async function botContext(core: Base, origin: string): Promise<BotContext> {
  const me = await botIdentity(core.api);
  return {
    ...core,
    origin,
    bot: {
      id: me.id,
      username: me.username ?? "",
      canReadAll: me.can_read_all_group_messages === true,
    },
  };
}

/**
 * `profile`: how the user is named in Telegram, and which assistant is
 * calling, when the caller already has them.
 */
export async function toolContext(
  core: Base,
  origin: string,
  userId: number,
  profile: { username: string | null; name: string | null; client?: string | null } = {
    username: null,
    name: null,
  },
): Promise<ToolContext> {
  const me = await botIdentity(core.api);
  const username = me.username ?? "";
  return {
    ...core,
    origin,
    userId,
    user: { id: userId, username: profile.username, name: profile.name },
    client: profile.client ?? null,
    bot: { id: me.id, username, canReadAll: me.can_read_all_group_messages === true },
    access: new Access(core.store, core.api, userId, username),
  };
}

import type { Config } from "../env";
import type { Store } from "../store";
import type { TelegramApi } from "../telegram/api";
import type { BotIdentity } from "./extract";

export interface BotContext {
  config: Config;
  store: Store;
  api: TelegramApi;
  bot: BotIdentity & {
    /** False when BotFather privacy mode is on: groups then only show commands and replies. */
    canReadAll: boolean;
  };
  /** The Worker's public origin, e.g. https://telegram-mcp.example.workers.dev */
  origin: string;
}

/**
 * A Bot API call returned as the webhook's own HTTP response — Telegram
 * performs it, which saves a subrequest. Only one fits per update, and its
 * result is never seen, so anything whose outcome matters goes through fetch.
 */
export type WebhookReply = { method: string } & Record<string, unknown>;

/**
 * Only someone who has signed an assistant in to this deployment may link
 * groups to it. Otherwise anyone could make the bot store their groups — on
 * the deployer's quota — for an assistant that does not exist.
 */
export async function hasConnected(ctx: BotContext, userId: number): Promise<boolean> {
  const row = await ctx.store.getUser(userId);
  return row?.connected_at !== null && row?.connected_at !== undefined;
}

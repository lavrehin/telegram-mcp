/**
 * Shared pieces of the tool surface: the per-request context, argument
 * schemas every tool reuses, error translation, and the send path every
 * writing tool goes through (so each sent message is stored the same way).
 */

import { z } from "zod";

import { AccessError, telegramChat, type Access, type ChatView } from "../access";
import type { Config } from "../env";
import { messageLink } from "../links";
import { markdownToHtml, splitMarkdown, splitPlain, TELEGRAM_CAPTION_LIMIT } from "../markdown";
import { BOT_ACCOUNT, type StoredButton, type Store } from "../store";
import { TelegramError, type TelegramApi } from "../telegram/api";
import type { UserRef } from "../prompts";
import type { InlineKeyboardMarkup, Message } from "../telegram/types";
import { toStored } from "../bot/extract";

export interface ToolContext {
  config: Config;
  store: Store;
  api: TelegramApi;
  access: Access;
  userId: number;
  /** The same user, with how Telegram names them — for the head of results. */
  user: UserRef;
  /** The calling assistant by its sign-in: "Claude", "ChatGPT"… Null when unknown. */
  client: string | null;
  /** Public origin of the Worker, for upload and download links. */
  origin: string;
  bot: { id: number; username: string; canReadAll: boolean };
}

export function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** A failure the model should read and act on, rather than a crash. */
export class ToolError extends Error {}

export function toolError(error: unknown, ctx: Pick<ToolContext, "bot">) {
  return { content: [{ type: "text" as const, text: describe(error, ctx) }], isError: true };
}

function describe(error: unknown, ctx: Pick<ToolContext, "bot">): string {
  if (error instanceof AccessError || error instanceof ToolError) return error.message;
  if (error instanceof TelegramError) {
    if (/business|BUSINESS_PEER/i.test(error.description)) {
      return (
        `Telegram refused: ${error.description}. In a personal chat the bot may act only as the user allowed ` +
        "in Telegram (Settings → Telegram Business → Chatbots), and only within 24 hours of the other " +
        "person's last message. Nothing was sent."
      );
    }
    if (/bot was blocked|user is deactivated/i.test(error.description)) {
      return `Telegram refused: ${error.description}. The user has to unblock the bot (https://t.me/${ctx.bot.username}) before it can message them.`;
    }
    if (/chat not found/i.test(error.description) || error.code === 403) {
      return (
        `Telegram refused: ${error.description}. If this is the private chat, the user has to open ` +
        `https://t.me/${ctx.bot.username} and press Start once. If it is a group, the bot may have been removed.`
      );
    }
    if (error.code === 429) {
      return `Telegram is rate-limiting the bot. Retry in ${error.retryAfter ?? 30} s, and send fewer messages.`;
    }
    if (
      /not enough rights|need administrator rights|CHAT_ADMIN_REQUIRED/i.test(error.description)
    ) {
      return `Telegram refused: ${error.description}. The bot needs to be a group admin with that right.`;
    }
    if (/message is not modified/i.test(error.description))
      return "Nothing changed: the message already looks like that.";
    if (
      /message to edit not found|message can't be edited|message to delete not found|message can't be deleted/i.test(
        error.description,
      )
    ) {
      return `Telegram refused: ${error.description}. Bots can edit only their own messages, and delete only within 48 hours.`;
    }
    return `Telegram refused: ${error.description} (${error.code}).`;
  }
  return error instanceof Error ? error.message : String(error);
}

// --- argument schemas -------------------------------------------------------

export const chatArg = z
  .union([z.string(), z.number()])
  .optional()
  .describe(
    'Where: "me" (default — the user\'s private chat with the bot), or a group or personal chat from list_chats: id, @username or name.',
  );

export const messageIdArg = z.number().int().positive().describe("Message id (the #number).");

export const topicArg = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    "Forum topic (thread) id, from list_chats or a message's header. Omit for General / non-forum chats.",
  );

/** `cse_…` (the environment) and `session_…` (links, get_session) name the same session. */
const SESSION_ID = /^(?:session|cse)_([0-9A-Za-z]{16,64})$/;

// Lenient on purpose: a malformed id is dropped rather than costing the user the message.
export const sessionArg = z
  .string()
  .max(100)
  .optional()
  .describe("Your Claude Code session id (cse_… or session_…), if you are a cloud session.");

/** One spelling in storage: session_…, as in claude.ai/code links. Anything else is dropped. */
export function sessionId(value: string | undefined): string | null {
  const match = value ? SESSION_ID.exec(value) : null;
  return match ? `session_${match[1]}` : null;
}

export const formatArg = z
  .enum(["markdown", "plain"])
  .optional()
  .describe(
    "markdown (default): **bold**, _italic_, `code`, ```blocks```, [links](url), > quotes. plain: sent as is.",
  );

const buttonSchema = z
  .object({
    text: z.string().min(1).max(64).describe("Label on the button."),
    data: z
      .string()
      .max(200)
      .optional()
      .describe("Value reported back when pressed (default: the label). Omit when using url."),
    url: z
      .string()
      .url()
      .optional()
      .describe("Makes it a link button instead; presses are not reported."),
  })
  .refine((button) => !(button.url && button.data), "A button has either url or data, not both.");

export const buttonsArg = z
  .array(z.array(buttonSchema).min(1).max(8))
  .max(8)
  .optional()
  .describe(
    "Inline buttons under the message, as rows: [[{text:'Yes'},{text:'No'}]]. Presses are recorded — read them with wait_for_reply or get_message.",
  );

export type Buttons = z.infer<typeof buttonsArg>;

export function keyboard(buttons: Buttons): InlineKeyboardMarkup | undefined {
  if (!buttons?.length) return undefined;
  return {
    inline_keyboard: buttons.map((row, r) =>
      row.map((button, c) =>
        button.url
          ? { text: button.text, url: button.url }
          : { text: button.text, callback_data: `cb:${r}.${c}` },
      ),
    ),
  };
}

export function storedButtons(buttons: Buttons): string | null {
  if (!buttons?.length) return null;
  const rows: StoredButton[][] = buttons.map((row) =>
    row.map((button) =>
      button.url
        ? { text: button.text, url: button.url }
        : { text: button.text, data: button.data ?? button.text },
    ),
  );
  return JSON.stringify(rows);
}

// --- time ------------------------------------------------------------------

/**
 * "2h", "3d", "45m", "1w", "today", "yesterday", or anything Date can parse
 * (ISO dates and date-times; no zone means UTC). Epoch seconds.
 */
export function parseTime(value: string | undefined, field: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const raw = value.trim().toLowerCase();
  const now = Date.now();
  const relative = /^(\d+(?:\.\d+)?)\s*(m|min|h|d|w)$/.exec(raw);
  if (relative) {
    const unit = { m: 60, min: 60, h: 3600, d: 86400, w: 604800 }[relative[2]]!;
    return Math.floor(now / 1000 - Number(relative[1]) * unit);
  }
  const startOfToday = Math.floor(now / 86_400_000) * 86_400;
  if (raw === "today") return startOfToday;
  if (raw === "yesterday") return startOfToday - 86_400;

  const iso = /^\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?)?$/.test(raw)
    ? `${raw.replace(" ", "t")}${raw.length > 10 ? "z" : ""}`
    : raw;
  const parsed = Date.parse(iso.toUpperCase());
  if (Number.isNaN(parsed)) {
    throw new ToolError(
      `${field}: "${value}" is not a time. Use "2h", "3d", "today", or an ISO date like 2026-10-20.`,
    );
  }
  return Math.floor(parsed / 1000);
}

// --- sending ---------------------------------------------------------------

export interface SendOptions {
  text: string;
  format?: "markdown" | "plain";
  buttons?: Buttons;
  replyTo?: number;
  silent?: boolean;
  linkPreview?: boolean;
  topic?: number;
  markChoice?: boolean;
  session?: string;
}

/** The forum topic to post in: given, or the one of the message being replied to. */
async function resolveTopic(
  ctx: ToolContext,
  chat: ChatView,
  options: { topic?: number; replyTo?: number },
) {
  if (options.topic) return options.topic;
  if (!options.replyTo) return undefined;
  const target = await ctx.store.getMessage(chat, options.replyTo);
  return target?.thread_id ?? undefined;
}

/**
 * Posting to a chat. In a personal chat a message goes out as the user, so it
 * needs the right they gave in Telegram (and a conversation that is still
 * open); buttons are refused there, as the other person would be the one
 * pressing them.
 */
export async function mayPost(
  ctx: ToolContext,
  chat: ChatView,
  buttons?: readonly unknown[],
): Promise<void> {
  if (chat.kind === "personal" && buttons?.length) {
    throw new ToolError(
      "Buttons are not available in personal chats: the other person, not the user, would press them.",
    );
  }
  await ctx.access.allow(chat, "reply");
}

/**
 * The bot's tools speak as the bot. A personal chat would make the same call
 * speak as the user, so it has tools of its own, which a client can gate.
 */
export function asBot(chat: ChatView, instead: string): void {
  if (chat.kind === "personal") {
    throw new ToolError(
      `${JSON.stringify(chat.title)} is a personal chat: anything sent there goes out as the user. Use ` +
        `${instead}, and only if the user asked for it in this conversation.`,
    );
  }
}

/** For tools that only make sense in the bot's own chats. */
export function notPersonal(chat: ChatView, why: string): void {
  if (chat.kind === "personal") throw new ToolError(`Not available in personal chats: ${why}`);
}

/** Persist what the bot just sent: its own message, or in a personal chat the user's, sent via Claude. */
export async function recordSent(
  ctx: ToolContext,
  chat: ChatView,
  sent: Message,
  extra: { text?: string; buttons?: string | null; markChoice?: boolean; session?: string } = {},
): Promise<void> {
  const personal = chat.account_id !== BOT_ACCOUNT;
  const stored = toStored(sent, ctx.bot, personal ? chat.account_id : undefined);
  stored.outgoing = true;
  stored.mentions_bot = false;
  if (extra.text !== undefined) stored.text = extra.text;
  stored.buttons = extra.buttons ?? null;
  stored.mark_choice = extra.markChoice ?? false;
  stored.sent_by = ctx.userId;
  stored.session_id = sessionId(extra.session);
  await ctx.store.insertMessage(stored, personal ? "personal" : "always");
}

/** Where a message went, for the model. */
export function where(chat: ChatView): string {
  if (chat.kind === "dm") return "the private chat";
  if (chat.kind === "personal")
    return `the user's personal chat with ${JSON.stringify(chat.title)}, as the user`;
  return JSON.stringify(chat.title);
}

export function sentLink(ctx: ToolContext, chat: ChatView, message: Message): string | null {
  // Outside forums message_thread_id marks a reply thread, which t.me links do not take.
  const topic = message.is_topic_message ? message.message_thread_id : undefined;
  return messageLink(chat, message.message_id, topic, ctx.bot.username);
}

/** Send text, split if long, buttons on the last part. Every part is stored. */
export async function sendText(
  ctx: ToolContext,
  chat: ChatView,
  options: SendOptions,
): Promise<Message[]> {
  await mayPost(ctx, chat, options.buttons);
  const format = options.format ?? "markdown";
  const parts = format === "markdown" ? splitMarkdown(options.text) : splitPlain(options.text);
  const thread = await resolveTopic(ctx, chat, options);
  const markup = keyboard(options.buttons);
  const sent: Message[] = [];

  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    const params: Record<string, unknown> = {
      ...telegramChat(chat),
      text: format === "markdown" ? markdownToHtml(part) : part,
      ...(format === "markdown" ? { parse_mode: "HTML" } : {}),
      ...(thread ? { message_thread_id: thread } : {}),
      ...(index === 0 && options.replyTo
        ? { reply_parameters: { message_id: options.replyTo, allow_sending_without_reply: true } }
        : {}),
      ...(options.silent ? { disable_notification: true } : {}),
      link_preview_options: { is_disabled: options.linkPreview !== true },
      ...(last && markup ? { reply_markup: markup } : {}),
    };

    const message = await withPlainFallback((plain) => {
      if (plain) {
        // Markup Telegram cannot parse should not lose the message: send it as written.
        delete params.parse_mode;
        params.text = part;
      }
      return ctx.api.call<Message>("sendMessage", params);
    });
    await recordSent(ctx, chat, message, {
      text: part,
      buttons: last ? storedButtons(options.buttons) : null,
      markChoice: last ? options.markChoice : false,
      session: options.session,
    });
    sent.push(message);
  }
  return sent;
}

export type UploadKind = "document" | "photo" | "video" | "audio" | "voice" | "animation";

export const UPLOAD_KINDS: [UploadKind, ...UploadKind[]] = [
  "document",
  "photo",
  "video",
  "audio",
  "voice",
  "animation",
];

export interface FileSendOptions {
  as?: UploadKind;
  caption?: string;
  format?: "markdown" | "plain";
  buttons?: Buttons;
  replyTo?: number;
  topic?: number;
  silent?: boolean;
  session?: string;
}

/** A file to send: bytes in hand, or a stream of known size straight from the uploader. */
export type UploadSource =
  { blob: Blob } | { stream: ReadableStream<Uint8Array>; size: number; type: string };

/**
 * Retry once as plain text when Telegram refuses the markup. The converter
 * always nests tags properly, so this is a backstop, not a path.
 */
export async function withPlainFallback<T>(send: (plain: boolean) => Promise<T>): Promise<T> {
  try {
    return await send(false);
  } catch (error) {
    if (error instanceof TelegramError && /can't parse entities/i.test(error.description)) {
      return send(true);
    }
    throw error;
  }
}

/** Upload a file message and store it. */
export async function sendUpload(
  ctx: ToolContext,
  chat: ChatView,
  source: UploadSource,
  filename: string,
  options: FileSendOptions,
): Promise<Message> {
  await mayPost(ctx, chat, options.buttons);
  const kind = options.as ?? "document";
  const method = `send${kind[0].toUpperCase()}${kind.slice(1)}`;
  const caption = options.caption?.slice(0, TELEGRAM_CAPTION_LIMIT);
  const markdown = (options.format ?? "markdown") === "markdown";
  const thread = await resolveTopic(ctx, chat, options);

  const { chat_id, business_connection_id } = telegramChat(chat);
  const params = (plain: boolean): Record<string, unknown> => ({
    chat_id: String(chat_id),
    ...(business_connection_id ? { business_connection_id } : {}),
    ...(caption ? { caption: markdown && !plain ? markdownToHtml(caption) : caption } : {}),
    ...(caption && markdown && !plain ? { parse_mode: "HTML" } : {}),
    ...(thread ? { message_thread_id: String(thread) } : {}),
    ...(options.replyTo
      ? { reply_parameters: { message_id: options.replyTo, allow_sending_without_reply: true } }
      : {}),
    ...(options.silent ? { disable_notification: "true" } : {}),
    ...(keyboard(options.buttons) ? { reply_markup: keyboard(options.buttons) } : {}),
  });

  // A stream can be read only once, so it gets no plain-text retry.
  const message =
    "blob" in source
      ? await withPlainFallback((plain) =>
          ctx.api.upload<Message>(method, params(plain), kind, source.blob, filename),
        )
      : await ctx.api.uploadStream<Message>(method, params(false), kind, {
          body: source.stream,
          size: source.size,
          name: filename,
          type: source.type,
        });
  await recordSent(ctx, chat, message, {
    text: caption ?? "",
    buttons: storedButtons(options.buttons),
    session: options.session,
  });
  return message;
}

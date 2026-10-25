/**
 * POST /telegram — every update Telegram sends the bot.
 *
 * Two gates before the body is even read: the caller's IP must be in
 * Telegram's published ranges, and X-Telegram-Bot-Api-Secret-Token must match
 * the secret we registered (derived from the bot token, compared in constant
 * time). Either failing is a 403.
 *
 * Past the gates the answer is always 200. Telegram retries anything else,
 * and a retried update is safe anyway — inserts are idempotent — but a retry
 * storm on a poison update would only burn quota.
 *
 * What gets written is deliberately narrow, because D1 bills per row: a
 * private chat only once its owner has pressed /start (or signed in), a group
 * only while at least one user holds a grant on it, a user's personal chats
 * only while they keep the bot connected to their account (Telegram Business)
 * and have signed an assistant in. Everything else is read and dropped.
 */

import { rightsOf } from "../access";
import { nowSeconds, timingSafeEqual } from "../crypto";
import { isAllowed } from "../env";
import { holdsSecret } from "../secrets";
import { TelegramError } from "../telegram/api";
import { isTelegramIp } from "../telegram/ip";
import {
  displayName,
  type BusinessBotRights,
  type BusinessConnection,
  type BusinessMessagesDeleted,
  type CallbackQuery,
  type ChatFullInfo,
  type ChatMemberUpdated,
  type Message,
  type MessageReactionUpdated,
  type Update,
  type User,
} from "../telegram/types";
import { BOT_ACCOUNT, type Guard } from "../store";
import { hasConnected, type BotContext, type WebhookReply } from "./context";
import { handleAssistantButton, handleChatShared, handleCommand, handleRevoke } from "./commands";
import { handleMemoryUndo, handleMenu } from "./menu";
import { handleSecret } from "./routine";
import { maybeStart } from "./triggers";
import { parseCommand, realReply, toStored, topicName, topicOf } from "./extract";
import { texts } from "./texts";

function webhookAllowed(request: Request, ctx: Pick<BotContext, "config">): boolean {
  const ip = request.headers.get("cf-connecting-ip");
  if (!ctx.config.skipIpCheck && !isTelegramIp(ip)) return false;
  const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  return timingSafeEqual(secret, ctx.config.webhookSecret);
}

/** Which guard a chat's messages are written under, or null when they never are. */
function guardFor(ctx: BotContext, message: Message): Guard | null {
  const chat = message.chat;
  if (chat.type === "private") return isAllowed(ctx.config, chat.id) ? "dm" : null;
  if (chat.type === "group" || chat.type === "supergroup") return "group";
  return null;
}

/** Topic names repeat on every message in a topic; skip the write once seen in this isolate. */
const topicNames = new Map<string, string>();

async function learnTopic(ctx: BotContext, message: Message): Promise<void> {
  const thread = topicOf(message);
  const name = topicName(message);
  if (!thread || !name) return;
  const key = `${message.chat.id}:${thread}`;
  if (topicNames.get(key) === name) return;
  await ctx.store.upsertTopic(message.chat.id, thread, name);
  topicNames.set(key, name);
}

/** Business connection id → its owner, so a busy personal chat costs no lookup per message. */
const connectionOwners = new Map<string, number>();

/** Whose account a business update belongs to, or null when the connection is unknown or off. */
async function ownerOf(ctx: BotContext, connectionId: string | undefined): Promise<number | null> {
  if (!connectionId) return null;
  const cached = connectionOwners.get(connectionId);
  if (cached !== undefined) return cached;
  const row = await ctx.store.businessConnectionById(connectionId);
  if (!row?.enabled) return null;
  connectionOwners.set(connectionId, row.user_id);
  return row.user_id;
}

// --- handlers --------------------------------------------------------------

async function onMessage(
  ctx: BotContext,
  message: Message,
  edited: boolean,
): Promise<WebhookReply | null> {
  if (message.migrate_to_chat_id) {
    await ctx.store.migrateChat(message.chat.id, message.migrate_to_chat_id);
    return null;
  }

  // A key in the private chat is never stored, edited in or not: it can start sessions on the account.
  if (
    message.chat.type === "private" &&
    message.from &&
    holdsSecret(message.text ?? message.caption)
  ) {
    return handleSecret(ctx, { ...message, from: message.from });
  }

  const guard = guardFor(ctx, message);
  if (guard) {
    const stored = toStored(message, ctx.bot);
    const fresh = edited
      ? (await ctx.store.upsertEditedMessage(stored, guard), true)
      : await ctx.store.insertMessage(stored, guard);
    // The message being replied to comes along in full. Keep it too, so the
    // reply makes sense even when the bot never saw the original (it predates
    // the bot, or privacy mode hid it). Ignored if already stored.
    const target = realReply(message);
    const cutoff = nowSeconds() - ctx.config.retentionDays * 86_400;
    if (fresh && !edited && target && target.chat.id === message.chat.id && target.date >= cutoff) {
      await ctx.store.insertMessage(toStored(target, ctx.bot), guard);
    }
    if (fresh && guard === "group") {
      await learnTopic(ctx, message);
      if (message.new_chat_title)
        await ctx.store.renameChat(message.chat.id, message.new_chat_title);
    }
  }

  if (edited) return null;
  if (message.chat_shared) return handleChatShared(message);
  if (message.left_chat_member) {
    await onMemberLeft(ctx, message.chat.id, message.left_chat_member);
    return null;
  }

  const command = parseCommand(message, ctx.bot);
  // A start that fails must not lose the update: it is told to the user, not retried.
  await maybeStart(ctx, message, command).catch((error: unknown) =>
    console.error(JSON.stringify({ event: "trigger_failed", error: String(error) })),
  );
  if (command) {
    return handleCommand(ctx, message, command);
  }
  return null;
}

/** The bot itself was added to, removed from, or promoted in a chat. */
async function onMyChatMember(
  ctx: BotContext,
  update: ChatMemberUpdated,
): Promise<WebhookReply | null> {
  const chat = update.chat;
  if (chat.type !== "group" && chat.type !== "supergroup") return null;

  const was = update.old_chat_member.status;
  const now = update.new_chat_member.status;
  const present = (status: string) => !["left", "kicked"].includes(status);

  if (!present(now)) {
    await ctx.store.deleteChat(chat.id);
    return null;
  }

  const isAdmin = now === "administrator" || now === "creator";

  if (!present(was)) {
    // Just added. Whoever added the bot gets access, if they may use it at all.
    const adder = update.from;
    if (!isAllowed(ctx.config, adder.id) || adder.is_bot) {
      await ctx.api.call("leaveChat", { chat_id: chat.id }).catch(() => undefined);
      return null;
    }
    if (!(await hasConnected(ctx, adder.id))) {
      // Say why before going, so the adder knows what to do.
      await ctx.api
        .call("sendMessage", {
          chat_id: chat.id,
          text: texts(adder.language_code).leavingNotConnected(displayName(adder)),
          parse_mode: "HTML",
        })
        .catch(() => undefined);
      await ctx.api.call("leaveChat", { chat_id: chat.id }).catch(() => undefined);
      return null;
    }

    await ctx.store.upsertChat({
      chat_id: chat.id,
      type: chat.type,
      title: chat.title,
      username: chat.username,
      is_forum: chat.is_forum,
      bot_is_admin: isAdmin,
    });
    await ctx.store.upsertUser({
      user_id: adder.id,
      username: adder.username,
      first_name: adder.first_name,
      language: adder.language_code,
    });
    // Nothing older than this moment exists for the bot, so there is nothing to hide.
    await ctx.store.upsertGrant(adder.id, chat.id, "added_bot", 0);

    const t = texts(adder.language_code);
    return {
      method: "sendMessage",
      chat_id: chat.id,
      parse_mode: "HTML",
      text: t.addedGreeting({
        name: displayName(adder),
        retention: ctx.config.retentionDays,
        privacyOn: !ctx.bot.canReadAll,
        admin: isAdmin,
      }),
    };
  }

  // Promoted or demoted. An admin bot can see whether history is visible to newcomers.
  let visible: boolean | null = null;
  if (isAdmin) {
    const info = await ctx.api
      .call<ChatFullInfo>("getChat", { chat_id: chat.id })
      .catch(() => null);
    visible = info?.has_visible_history ?? null;
  }
  await ctx.store.upsertChat({
    chat_id: chat.id,
    type: chat.type,
    title: chat.title,
    username: chat.username,
    is_forum: chat.is_forum,
    bot_is_admin: isAdmin,
    visible_history: visible,
  });
  return null;
}

/** Someone else joined or left. Only reaches admin bots. */
async function onChatMember(ctx: BotContext, update: ChatMemberUpdated): Promise<void> {
  const status = update.new_chat_member.status;
  const left =
    status === "left" ||
    status === "kicked" ||
    (status === "restricted" && update.new_chat_member.is_member === false);
  if (!left) return;

  await onMemberLeft(ctx, update.chat.id, update.new_chat_member.user);
}

/**
 * Someone left or was removed: their access to the group goes with them. The
 * bot itself leaving is my_chat_member's business. Reached through chat_member
 * when the bot is an admin, and through the service message when it is not.
 */
async function onMemberLeft(ctx: BotContext, chatId: number, user: User): Promise<void> {
  if (user.id === ctx.bot.id) return;
  if (!(await ctx.store.getGrant(user.id, chatId))) return;
  await ctx.store.revokeGrant(user.id, chatId);
}

async function onCallback(ctx: BotContext, query: CallbackQuery): Promise<WebhookReply | null> {
  const data = query.data ?? "";

  const revoke = /^rv:(-?\d+)$/.exec(data);
  if (revoke) {
    if (!isAllowed(ctx.config, query.from.id)) {
      return {
        method: "answerCallbackQuery",
        callback_query_id: query.id,
        text: texts(query.from.language_code)
          .notAllowed(query.from.id)
          .replace(/<[^>]+>/g, ""),
      };
    }
    return handleRevoke(ctx, query, Number(revoke[1]));
  }

  const undo = /^mu(!?):(\d+)(?::(\d+))?$/.exec(data);
  if (undo) {
    return handleMemoryUndo(ctx, query, Number(undo[2]), undo[1] ? null : Number(undo[3] ?? 0));
  }

  const menu = /^m:([\w:-]{1,60})$/.exec(data);
  if (menu) return handleMenu(ctx, query, menu[1]);

  const press = /^cb:(\d+)\.(\d+)$/.exec(data);
  if (press) return handleAssistantButton(ctx, query, Number(press[1]), Number(press[2]));

  return {
    method: "answerCallbackQuery",
    callback_query_id: query.id,
    text: texts(query.from.language_code).alreadyAnswered,
  };
}

/** Reactions are kept only on the bot's own messages — they are answers to it. */
async function onReaction(ctx: BotContext, update: MessageReactionUpdated): Promise<void> {
  const user = update.user;
  if (!user) return;
  const stored = await ctx.store.getMessage(
    { account_id: BOT_ACCOUNT, chat_id: update.chat.id },
    update.message_id,
  );
  if (!stored?.outgoing) return;

  const emoji = update.new_reaction
    .map((reaction) => (reaction.type === "emoji" ? reaction.emoji : `[${reaction.type}]`))
    .filter(Boolean)
    .join("");
  if (!emoji) {
    await ctx.store.deleteReaction(update.chat.id, update.message_id, user.id);
    return;
  }
  await ctx.store.setReaction({
    chat_id: update.chat.id,
    message_id: update.message_id,
    user_id: user.id,
    user_name: user.username ? `@${user.username}` : displayName(user),
    emoji,
    date: update.date || nowSeconds(),
  });
}

const SHOWN_RIGHTS: (keyof BusinessBotRights)[] = [
  "can_reply",
  "can_read_messages",
  "can_delete_sent_messages",
];

/**
 * The user connected the bot to their account, changed what it may do, or
 * disconnected it. They are told what their assistant can now do, in their
 * private chat with the bot; turning it off deletes everything it brought.
 */
async function onBusinessConnection(
  ctx: BotContext,
  connection: BusinessConnection,
): Promise<WebhookReply | null> {
  const owner = connection.user;
  const t = texts(owner.language_code);
  const say = (text: string): WebhookReply => ({
    method: "sendMessage",
    chat_id: connection.user_chat_id,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });

  connectionOwners.delete(connection.id);
  if (!isAllowed(ctx.config, owner.id)) {
    await ctx.store.dropPersonal(owner.id);
    return connection.is_enabled ? say(t.notAllowed(owner.id)) : null;
  }
  if (!connection.is_enabled) {
    await ctx.store.dropPersonal(owner.id);
    return say(t.businessOff);
  }

  const rights = connection.rights ?? {};
  const before = await ctx.store.getBusinessConnection(owner.id);
  await ctx.store.upsertUser({
    user_id: owner.id,
    username: owner.username,
    first_name: owner.first_name,
    language: owner.language_code,
  });
  await ctx.store.upsertBusinessConnection({
    user_id: owner.id,
    connection_id: connection.id,
    rights: JSON.stringify(rights),
    enabled: true,
  });

  const changed = before?.enabled === 1 && before.connection_id === connection.id;
  const previous = before ? rightsOf(before) : {};
  if (changed && SHOWN_RIGHTS.every((right) => !previous[right] === !rights[right])) return null;
  return say(
    t.business({
      changed,
      reply: rights.can_reply === true,
      read: rights.can_read_messages === true,
      delete: rights.can_delete_sent_messages === true,
      retention: ctx.config.retentionDays,
      signedIn: await hasConnected(ctx, owner.id),
    }),
  );
}

/** A message in one of a user's personal chats: theirs, the other person's, or sent by us for them. */
async function onBusinessMessage(
  ctx: BotContext,
  message: Message,
  edited: boolean,
): Promise<void> {
  if (message.chat.type !== "private") return;
  const owner = await ownerOf(ctx, message.business_connection_id);
  if (owner === null) return;
  if (!isAllowed(ctx.config, owner)) {
    // Taken off the allowlist since connecting: nothing of theirs may stay.
    connectionOwners.delete(message.business_connection_id!);
    await ctx.store.dropPersonal(owner);
    return;
  }

  // No per-isolate cache here: the row goes when the connection ends or the
  // chat falls out of retention, and must come back with the next message.
  // An unchanged name costs a read, not a write.
  const chat = message.chat;
  await ctx.store.upsertPersonalChat({
    account_id: owner,
    chat_id: chat.id,
    title: [chat.first_name, chat.last_name].filter(Boolean).join(" ") || null,
    username: chat.username ?? null,
  });

  const stored = toStored(message, ctx.bot, owner);
  if (edited) {
    await ctx.store.upsertEditedMessage(stored, "personal");
    return;
  }
  const fresh = await ctx.store.insertMessage(stored, "personal");
  const target = realReply(message);
  const cutoff = nowSeconds() - ctx.config.retentionDays * 86_400;
  if (fresh && target && target.chat.id === chat.id && target.date >= cutoff) {
    await ctx.store.insertMessage(toStored(target, ctx.bot, owner), "personal");
  }
}

/** The user or the other person deleted messages in a personal chat; so do we. */
async function onBusinessDeleted(ctx: BotContext, deleted: BusinessMessagesDeleted): Promise<void> {
  const owner = await ownerOf(ctx, deleted.business_connection_id);
  if (owner === null) return;
  await ctx.store.deleteMessages(
    { account_id: owner, chat_id: deleted.chat.id },
    deleted.message_ids,
  );
}

async function dispatch(ctx: BotContext, update: Update): Promise<WebhookReply | null> {
  if (update.message) return onMessage(ctx, update.message, false);
  if (update.edited_message) return onMessage(ctx, update.edited_message, true);
  if (update.my_chat_member) return onMyChatMember(ctx, update.my_chat_member);
  if (update.chat_member) {
    await onChatMember(ctx, update.chat_member);
    return null;
  }
  if (update.callback_query) return onCallback(ctx, update.callback_query);
  if (update.message_reaction) {
    await onReaction(ctx, update.message_reaction);
    return null;
  }
  if (update.business_connection) return onBusinessConnection(ctx, update.business_connection);
  if (update.business_message) {
    await onBusinessMessage(ctx, update.business_message, false);
    return null;
  }
  if (update.edited_business_message) {
    await onBusinessMessage(ctx, update.edited_business_message, true);
    return null;
  }
  if (update.deleted_business_messages) {
    await onBusinessDeleted(ctx, update.deleted_business_messages);
    return null;
  }
  return null;
}

export async function handleWebhook(
  request: Request,
  makeContext: () => Promise<BotContext>,
  base: Pick<BotContext, "config">,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!webhookAllowed(request, base)) return new Response(null, { status: 403 });

  let update: Update;
  try {
    update = await request.json<Update>();
  } catch {
    return new Response(null, { status: 200 });
  }

  try {
    const ctx = await makeContext();
    const reply = await dispatch(ctx, update);
    if (reply) return Response.json(reply);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "webhook_error",
        update_id: update.update_id,
        error: error instanceof Error ? error.message : String(error),
        telegram: error instanceof TelegramError ? error.description : undefined,
      }),
    );
    // A press left unanswered keeps spinning in the user's client.
    if (update.callback_query) {
      return Response.json({
        method: "answerCallbackQuery",
        callback_query_id: update.callback_query.id,
        text: "Something went wrong. Try again.",
      });
    }
  }
  return new Response(null, { status: 200 });
}

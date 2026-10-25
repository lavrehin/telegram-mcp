/**
 * Bot commands and button presses: the bot's own settings UI.
 *
 *   /start, /help       the menu (src/bot/menu.ts)
 *   /connect            in a group: link the sender; in DM: how to do that
 *   /groups             connected groups, each with a Revoke button
 *   /disconnect         sign out every assistant connected with this account
 *
 * Answers go back as webhook replies where one call is enough.
 */

import { nowSeconds } from "../crypto";
import { isAllowed } from "../env";
import { TelegramError } from "../telegram/api";
import {
  displayName,
  type CallbackQuery,
  type ChatFullInfo,
  type InlineKeyboardMarkup,
  type Message,
  type User,
} from "../telegram/types";
import { isChatGoneError } from "../access";
import { BOT_ACCOUNT } from "../store";
import { hasConnected, type BotContext, type WebhookReply } from "./context";
import { topicOf, type Command } from "./extract";
import { addToGroupUrl, mainScreen } from "./menu";
import { formatDate, texts } from "./texts";

/** Answer in the same chat, in the same forum topic, as a reply in groups. */
function replyTo(message: Message, text: string, extra: object = {}): WebhookReply {
  const thread = topicOf(message);
  return {
    method: "sendMessage",
    chat_id: message.chat.id,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(thread ? { message_thread_id: thread } : {}),
    ...(message.chat.type === "private"
      ? {}
      : {
          reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
        }),
    ...extra,
  };
}

function notAllowed(message: Message, user: User): WebhookReply {
  return replyTo(message, texts(user.language_code).notAllowed(user.id));
}

export async function handleCommand(
  ctx: BotContext,
  message: Message,
  command: Command,
): Promise<WebhookReply | null> {
  const user = message.from;
  if (!user || user.is_bot) return null;
  const t = texts(user.language_code);
  const isPrivate = message.chat.type === "private";

  // In groups, stay quiet about commands that are not for us or not ours to answer.
  if (!isPrivate && command.name !== "connect") return null;
  if (!isAllowed(ctx.config, user.id)) return notAllowed(message, user);

  switch (command.name) {
    case "start":
    case "help": {
      await ctx.store.upsertUser({
        user_id: user.id,
        username: user.username,
        first_name: user.first_name,
        language: user.language_code,
      });
      const screen = await mainScreen(ctx, user);
      return replyTo(message, screen.text, { reply_markup: screen.reply_markup });
    }

    case "connect":
      if (!(await hasConnected(ctx, user.id))) return replyTo(message, t.connectFirst);
      if (!isPrivate) return connectHere(ctx, message, user);
      return replyTo(message, t.connectInPrivate(ctx.bot.username), {
        reply_markup: {
          inline_keyboard: [[{ text: t.buttonAddToGroup, url: addToGroupUrl(ctx) }]],
        },
      });

    case "groups":
      return replyTo(message, ...(await groupsMessage(ctx, user)));

    case "disconnect":
      await ctx.store.bumpTokenVersion(user.id);
      return replyTo(message, t.disconnected);

    default:
      return replyTo(message, t.unknownCommand);
  }
}

/** A press on the group picker keyboard older versions sent: put it away. */
export function handleChatShared(message: Message): WebhookReply | null {
  const user = message.from;
  if (!user || !message.chat_shared) return null;
  return replyTo(message, texts(user.language_code).useMenu, {
    reply_markup: { remove_keyboard: true },
  });
}

/** /connect sent inside the group: the sender is a member by definition. */
async function connectHere(
  ctx: BotContext,
  message: Message,
  user: User,
): Promise<WebhookReply | null> {
  // An anonymous admin posts as the group; there is no person to link.
  if (message.sender_chat) return null;
  const text = await connectChat(ctx, user, message.chat.id);
  return replyTo(message, text);
}

/**
 * Grant `user` access to a group they just wrote /connect in, deciding how
 * much of the stored history they may see: all of it only when the group
 * shows history to new members, which only an admin bot can tell.
 */
async function connectChat(ctx: BotContext, user: User, chatId: number): Promise<string> {
  const t = texts(user.language_code);
  if (!(await hasConnected(ctx, user.id))) return t.connectFirst;

  let chat: ChatFullInfo;
  try {
    chat = await ctx.api.call<ChatFullInfo>("getChat", { chat_id: chatId });
  } catch (error) {
    if (error instanceof TelegramError) {
      return isChatGoneError(error) ? t.notInGroup : t.notMember;
    }
    throw error;
  }
  if (chat.type !== "group" && chat.type !== "supergroup") return t.notAGroup;

  // Public groups always show history to newcomers; private ones say so only to admins.
  const visible = chat.username ? true : chat.has_visible_history;
  await ctx.store.upsertChat({
    chat_id: chat.id,
    type: chat.type,
    title: chat.title,
    username: chat.username,
    is_forum: chat.is_forum,
    visible_history: visible ?? null,
  });
  await ctx.store.upsertUser({
    user_id: user.id,
    username: user.username,
    first_name: user.first_name,
    language: user.language_code,
  });
  const grant = await ctx.store.upsertGrant(
    user.id,
    chat.id,
    "connect",
    visible === true ? 0 : nowSeconds(),
  );

  return t.connected({
    title: chat.title ?? String(chat.id),
    full: grant.visible_from === 0,
    retention: ctx.config.retentionDays,
    name: displayName(user),
  });
}

async function groupsMessage(
  ctx: BotContext,
  user: User,
): Promise<[string, { reply_markup?: InlineKeyboardMarkup }]> {
  const t = texts(user.language_code);
  const grants = await ctx.store.listGrants(user.id);
  if (!grants.length) return [t.noGroups, {}];

  const lines = grants.map((grant) =>
    t.groupLine({
      title: grant.title ?? String(grant.chat_id),
      full: grant.visible_from === 0,
      since: formatDate(grant.visible_from),
    }),
  );
  return [
    [t.groupsHeader, ...lines].join("\n"),
    {
      reply_markup: {
        inline_keyboard: grants.map((grant) => [
          {
            text: t.revokeButton((grant.title ?? String(grant.chat_id)).slice(0, 40)),
            callback_data: `rv:${grant.chat_id}`,
          },
        ]),
      },
    },
  ];
}

/** Revoke buttons from /groups. */
export async function handleRevoke(
  ctx: BotContext,
  query: CallbackQuery,
  chatId: number,
): Promise<WebhookReply> {
  const t = texts(query.from.language_code);
  const grant = await ctx.store.getGrant(query.from.id, chatId);
  if (!grant)
    return { method: "answerCallbackQuery", callback_query_id: query.id, text: t.notYours };

  await ctx.store.revokeGrant(query.from.id, chatId);

  // Refresh the list in place; the answer to the press rides on the webhook reply.
  if (query.message) {
    const [text, extra] = await groupsMessage(ctx, query.from);
    await ctx.api
      .call("editMessageText", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        text,
        parse_mode: "HTML",
        reply_markup: extra.reply_markup ?? { inline_keyboard: [] },
      })
      .catch(() => undefined);
  }
  return { method: "answerCallbackQuery", callback_query_id: query.id, text: t.revoked };
}

/**
 * A press on a button the assistant sent. Recorded for wait_for_reply and
 * get_message; with `mark_choice`, the keyboard collapses into the one
 * chosen answer so nobody presses twice.
 */
export async function handleAssistantButton(
  ctx: BotContext,
  query: CallbackQuery,
  row: number,
  column: number,
): Promise<WebhookReply> {
  const t = texts(query.from.language_code);
  const answer = (text: string): WebhookReply => ({
    method: "answerCallbackQuery",
    callback_query_id: query.id,
    text,
  });
  const message = query.message;
  if (!message) return answer(t.alreadyAnswered);

  // Buttons are only ever sent in the bot's own chats, never in a user's personal ones.
  const chat = { account_id: BOT_ACCOUNT, chat_id: message.chat.id };
  const stored = await ctx.store.getMessage(chat, message.message_id);
  const buttons = stored?.buttons
    ? (JSON.parse(stored.buttons) as { text: string; data?: string }[][])
    : null;
  const button = buttons?.[row]?.[column];
  if (!stored || !button) return answer(t.alreadyAnswered);

  await ctx.store.insertPress({
    chat_id: message.chat.id,
    message_id: message.message_id,
    callback_id: query.id,
    user_id: query.from.id,
    user_name: query.from.username ? `@${query.from.username}` : displayName(query.from),
    label: button.text,
    data: button.data ?? button.text,
    date: nowSeconds(),
  });

  if (stored.mark_choice) {
    await ctx.api
      .call("editMessageReplyMarkup", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        reply_markup: {
          inline_keyboard: [[{ text: t.pressed(button.text), callback_data: "noop" }]],
        },
      })
      .catch(() => undefined);
    // The question is answered: forget its buttons, so a later edit cannot bring them back.
    await ctx.store.updateOutgoing(chat, message.message_id, {
      buttons: null,
      markChoice: false,
    });
  }
  return answer(t.pressed(button.text));
}

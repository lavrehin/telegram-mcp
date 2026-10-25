/**
 * Turn a Telegram message into the row we keep.
 *
 * Text and caption are one field; every kind of attachment collapses into
 * one file slot (the largest photo size, the document, the voice note…); and
 * the things a model will want to filter on — was the bot mentioned, which
 * forum topic, what is it replying to — are worked out once, here.
 */

import { BOT_ACCOUNT, type StoredMessage } from "../store";
import { displayName, type Message, type MessageEntity, type User } from "../telegram/types";

export interface BotIdentity {
  id: number;
  username: string;
}

interface FileInfo {
  kind: string;
  id: string;
  name: string | null;
  mime: string | null;
  size: number | null;
}

function fileOf(message: Message): FileInfo | null {
  if (message.document) {
    const d = message.document;
    return {
      kind: "document",
      id: d.file_id,
      name: d.file_name ?? null,
      mime: d.mime_type ?? null,
      size: d.file_size ?? null,
    };
  }
  if (message.photo?.length) {
    const largest = message.photo.reduce((best, size) =>
      size.width * size.height > best.width * best.height ? size : best,
    );
    return {
      kind: "photo",
      id: largest.file_id,
      name: `photo_${message.message_id}.jpg`,
      mime: "image/jpeg",
      size: largest.file_size ?? null,
    };
  }
  const simple: [string, Message[keyof Message] | undefined, string][] = [
    ["video", message.video, "mp4"],
    ["animation", message.animation, "mp4"],
    ["audio", message.audio, "mp3"],
    ["voice", message.voice, "ogg"],
    ["video_note", message.video_note, "mp4"],
    ["sticker", message.sticker, "webp"],
  ];
  for (const [kind, value, extension] of simple) {
    if (!value || typeof value !== "object" || !("file_id" in value)) continue;
    const file = value as {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
    return {
      kind,
      id: file.file_id,
      name: file.file_name ?? `${kind}_${message.message_id}.${extension}`,
      mime: file.mime_type ?? null,
      size: file.file_size ?? null,
    };
  }
  return null;
}

/** Text for messages that carry none of their own, so search and listings still say something. */
function describeNonText(message: Message): string {
  if (message.sticker)
    return message.sticker.emoji ? `[sticker ${message.sticker.emoji}]` : "[sticker]";
  if (message.location) {
    return `[location ${message.location.latitude}, ${message.location.longitude}]`;
  }
  if (message.contact) {
    const name = [message.contact.first_name, message.contact.last_name].filter(Boolean).join(" ");
    return `[contact ${name} ${message.contact.phone_number}]`;
  }
  if (message.poll) {
    return `[poll] ${message.poll.question} — ${message.poll.options.map((o) => o.text).join(" / ")}`;
  }
  if (message.forum_topic_created) return `[topic created: ${message.forum_topic_created.name}]`;
  if (message.forum_topic_edited?.name)
    return `[topic renamed: ${message.forum_topic_edited.name}]`;
  if (message.new_chat_title) return `[chat renamed: ${message.new_chat_title}]`;
  return "";
}

function originName(message: Message): string | null {
  const origin = message.forward_origin;
  if (!origin) return null;
  if (origin.sender_user) {
    const user = origin.sender_user;
    return user.username ? `${displayName(user)} (@${user.username})` : displayName(user);
  }
  if (origin.sender_user_name) return origin.sender_user_name;
  const chat = origin.sender_chat ?? origin.chat;
  return chat?.title ?? chat?.username ?? "unknown";
}

/** Whether a message says or carries anything: not a service message. */
export function hasContent(message: Message): boolean {
  return Boolean(
    message.text ||
    message.caption ||
    fileOf(message) ||
    message.location ||
    message.contact ||
    message.poll,
  );
}

/**
 * In a forum, every message that is not an explicit reply arrives with
 * `reply_to_message` set to the topic's creation message. That is the
 * thread, not a reply, and must not read as one.
 */
export function realReply(message: Message): Message | undefined {
  const reply = message.reply_to_message;
  if (!reply || reply.forum_topic_created) return undefined;
  return reply;
}

/** The forum topic a message belongs to, or null outside forums (and in General). */
export function topicOf(message: Message): number | null {
  return message.is_topic_message && message.message_thread_id ? message.message_thread_id : null;
}

/** The topic's name, when this message carries it (see `realReply`). */
export function topicName(message: Message): string | null {
  if (!topicOf(message)) return null;
  if (message.forum_topic_created) return message.forum_topic_created.name;
  if (message.forum_topic_edited?.name) return message.forum_topic_edited.name;
  return message.reply_to_message?.forum_topic_created?.name ?? null;
}

function entityText(text: string, entity: MessageEntity): string {
  // Entity offsets are UTF-16 code units, which is exactly what JS strings index by.
  return text.slice(entity.offset, entity.offset + entity.length);
}

function quoteOf(message: Message): string | null {
  if (message.quote?.text) return message.quote.text;
  const external = message.external_reply;
  if (external) {
    const where = external.chat?.title ?? external.chat?.username ?? "another chat";
    return `[reply to a message in ${where}]`;
  }
  return null;
}

export function mentionsBot(message: Message, bot: BotIdentity): boolean {
  if (message.chat.type === "private") return true;
  return tagsBot(message, bot) || realReply(message)?.from?.id === bot.id;
}

/** The message names the bot: @username, a text mention, or a command addressed to it. */
export function tagsBot(message: Message, bot: BotIdentity): boolean {
  const handle = `@${bot.username}`.toLowerCase();
  const text = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities ?? [];
  for (const entity of entities) {
    if (entity.type === "mention" && entityText(text, entity).toLowerCase() === handle) return true;
    if (entity.type === "text_mention" && entity.user?.id === bot.id) return true;
    if (entity.type === "bot_command" && entityText(text, entity).toLowerCase().endsWith(handle)) {
      return true;
    }
  }
  // Telegram marks @mentions as entities; plain text is the fallback for clients that do not.
  return new RegExp(`(^|[^\\w])${handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
    text,
  );
}

/** A bot's @username when it is a well-formed one, else "" — "some inline bot". */
function botHandle(bot: User): string {
  return bot.username && /^\w{1,64}$/.test(bot.username) ? bot.username : "";
}

function senderOf(message: Message): {
  id: number | null;
  name: string | null;
  username: string | null;
} {
  const user: User | undefined = message.from;
  if (message.sender_chat) {
    // Anonymous admins and channel posts speak as the chat.
    return {
      id: message.sender_chat.id,
      name: message.sender_chat.title ?? null,
      username: message.sender_chat.username ?? null,
    };
  }
  if (!user) return { id: null, name: null, username: null };
  return { id: user.id, name: displayName(user), username: user.username ?? null };
}

/**
 * @param owner for a message from a business connection: the user whose
 *   account it belongs to. Their own messages count as outgoing, and the ones
 *   the bot sent for them are marked as sent by them.
 */
export function toStored(message: Message, bot: BotIdentity, owner?: number): StoredMessage {
  const file = fileOf(message);
  const sender = senderOf(message);
  const body = message.text ?? message.caption ?? "";
  const text = body || describeNonText(message);
  const viaBot =
    owner !== undefined && message.from?.id === owner && message.sender_business_bot?.id === bot.id;

  return {
    account_id: owner ?? BOT_ACCOUNT,
    chat_id: message.chat.id,
    message_id: message.message_id,
    date: message.date,
    edited_at: message.edit_date ?? null,
    thread_id: topicOf(message),
    from_id: sender.id,
    from_name: sender.name,
    from_username: sender.username,
    forwarded_from: originName(message),
    text,
    reply_to_id: realReply(message)?.message_id ?? null,
    quote: quoteOf(message),
    mentions_bot: owner === undefined && mentionsBot(message, bot),
    outgoing: message.from?.id === (owner ?? bot.id),
    file_kind: file?.kind ?? null,
    file_id: file?.id ?? null,
    file_name: file?.name ?? null,
    file_mime: file?.mime ?? null,
    file_size: file?.size ?? null,
    buttons: null,
    mark_choice: false,
    sent_by: viaBot ? owner : null,
    // Only a real handle is kept: a bot's display name is free text and could pose as a marker.
    via_bot: message.via_bot ? botHandle(message.via_bot) : null,
    as_chat: message.sender_chat !== undefined,
    session_id: null,
    album: message.media_group_id ?? null,
  };
}

export interface Command {
  name: string;
  args: string;
}

/**
 * `/name@bot args` → { name, args }. A command addressed to another bot is
 * not ours; a bare `/name` in a group is ours too, as Telegram delivers it.
 */
export function parseCommand(message: Message, bot: BotIdentity): Command | null {
  const text = message.text ?? "";
  const match = /^\/([a-zA-Z0-9_]{1,32})(?:@([a-zA-Z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/.exec(
    text.trim(),
  );
  if (!match) return null;
  const [, name, target, args] = match;
  if (target && target.toLowerCase() !== bot.username.toLowerCase()) return null;
  return { name: name.toLowerCase(), args: (args ?? "").trim() };
}

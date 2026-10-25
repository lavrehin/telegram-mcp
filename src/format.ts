/**
 * How messages read to the model: one compact line each, carrying what the
 * next call needs (ids), what a person would want relayed (who, when, where,
 * a t.me link), and the context that changes meaning — what it replies to,
 * which forum topic, whether the bot was tagged.
 *
 * All of it is written by whoever posted it, so each message is fenced in a
 * tag picked fresh for every result and absent from its content: a message
 * cannot close the fence early and pose as tool output. Sender ids, with the user
 * marked, tell the user's words from everyone else's.
 *
 *   <tg-Xy7k>
 *   #4512 · 2026-10-22 14:03 · Team chat › Design · "Alice" (@alice, id 111, the user) 🔔
 *     ↩ #4510 "Bob" (id 222): "can someone check the deploy?"
 *     Looks good, @bot please summarise
 *     📎 report.pdf (2.1 MB, document)
 *     https://t.me/c/123/7/4512
 *   </tg-Xy7k>
 *
 * An album — photos or files sent together, one message each in Telegram —
 * reads as one entry, with a 📎 line per item naming its message id.
 */

import type { ChatView } from "./access";
import { randomId } from "./crypto";
import { messageLink } from "./links";
import { untrustedNote, type UserRef } from "./prompts";
import {
  BOT_ACCOUNT,
  refKey,
  type ChatRef,
  type PressRow,
  type ReactionRow,
  type StoredMessage,
  type TopicRow,
} from "./store";

const SNIPPET_LENGTH = 500;
const REPLY_PREVIEW_LENGTH = 120;

export function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}

export function humanSize(bytes: number | null | undefined): string {
  if (!bytes) return "size unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function clip(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/**
 * `"Alice" (@alice, id 111, the user)`: who, and whether it is the user. The
 * name is quoted, so one like `Alice (id 111, the user)` cannot pass for the
 * marker that follows it. `marks` follow: what about the message is not the
 * sender's own words.
 */
export function person(
  name: string | null,
  username: string | null,
  id: number | null,
  userId: number,
  marks: string[] = [],
): string {
  const details = [
    username ? `@${username}` : null,
    id === null ? null : `id ${id}`,
    id === userId ? "the user" : null,
    ...marks,
  ].filter(Boolean);
  const quoted = JSON.stringify(name ?? "unknown");
  return details.length ? `${quoted} (${details.join(", ")})` : quoted;
}

function sender(message: StoredMessage, botUsername: string, userId: number): string {
  if (message.outgoing && message.account_id !== BOT_ACCOUNT) {
    // A personal chat: outgoing is the user writing to that person, by hand or through you.
    const who = person(message.from_name, message.from_username, message.from_id, userId);
    return message.sent_by !== null ? `${who}, sent by you` : who;
  }
  if (message.outgoing) return `bot (@${botUsername}, you)`;
  const marks = [
    message.forwarded_from ? "forwarding" : null,
    message.via_bot === null
      ? null
      : /^\w{1,64}$/.test(message.via_bot)
        ? `via @${message.via_bot}`
        : "via an inline bot",
    message.as_chat ? "posting as the chat" : null,
  ].filter((mark): mark is string => mark !== null);
  return person(message.from_name, message.from_username, message.from_id, userId, marks);
}

const FENCE_TRIES = 5;

/** Everything in a stored message its sender chose. */
function authored(message: StoredMessage): string[] {
  return [
    message.text,
    message.quote,
    message.from_name,
    message.from_username,
    message.forwarded_from,
    message.via_bot,
    message.file_name,
    message.file_mime,
    message.buttons,
  ].filter((part): part is string => part !== null);
}

/**
 * A tag unique to one result, around content written by others. Picked
 * before anything is wrapped, against everything the result will carry, so
 * the content is left as is. A random tag is next to impossible to hit; if
 * every try does, the last one stands.
 */
export class Fence {
  readonly tag: string;

  constructor(
    private readonly user: UserRef,
    contents: string[],
    nextTag = () => `tg-${randomId(3)}`,
  ) {
    let tag = nextTag();
    for (let i = 1; i < FENCE_TRIES && contents.some((part) => part.includes(tag)); i++) {
      tag = nextTag();
    }
    this.tag = tag;
  }

  wrap(body: string): string {
    return `<${this.tag}>\n${body}\n</${this.tag}>`;
  }

  /** The line that heads a result, saying what the fence means. */
  note(): string {
    return untrustedNote(this.tag, this.user);
  }
}

export class Renderer {
  private readonly chats: Map<string, ChatView>;
  private readonly topics = new Map<string, string>();
  readonly fence: Fence;
  private readonly userId: number;

  constructor(
    private readonly botUsername: string,
    user: UserRef,
    chats: ChatView[],
    topics: TopicRow[] = [],
    /** Every message the result shows, keyed `account:chat:message`, for reply previews. */
    private readonly replyTargets = new Map<string, StoredMessage>(),
    /** Other content the result carries inside the fence. */
    extra: string[] = [],
  ) {
    this.userId = user.id;
    this.chats = new Map(chats.map((chat) => [refKey(chat), chat]));
    for (const topic of topics) this.topics.set(`${topic.chat_id}:${topic.thread_id}`, topic.name);
    this.fence = new Fence(user, [
      ...[...replyTargets.values()].flatMap(authored),
      ...chats.map((chat) => chat.title),
      ...topics.map((topic) => topic.name),
      ...extra,
    ]);
  }

  topicName(chatId: number, threadId: number | null): string | null {
    if (!threadId) return null;
    return this.topics.get(`${chatId}:${threadId}`) ?? `topic ${threadId}`;
  }

  link(
    message: Pick<StoredMessage, "account_id" | "chat_id" | "message_id" | "thread_id">,
  ): string | null {
    const chat = this.chats.get(refKey(message));
    if (!chat) return null;
    return messageLink(chat, message.message_id, message.thread_id, this.botUsername);
  }

  where(ref: ChatRef, threadId: number | null): string {
    const chat = this.chats.get(refKey(ref));
    const title =
      chat?.kind === "dm"
        ? "DM"
        : chat?.kind === "personal"
          ? `personal: ${chat.title}`
          : (chat?.title ?? String(ref.chat_id));
    const topic = this.topicName(ref.chat_id, threadId);
    return topic ? `${title} › ${topic}` : title;
  }

  /** Messages in the order given, each album's items run together into one entry. */
  messages(list: StoredMessage[], options: { showChat?: boolean } = {}): string[] {
    const entries: StoredMessage[][] = [];
    for (const message of list) {
      const last = entries.at(-1);
      if (
        message.album &&
        last?.[0].album === message.album &&
        refKey(last[0]) === refKey(message)
      ) {
        last.push(message);
      } else {
        entries.push([message]);
      }
    }
    return entries.map((items) => this.message(items[0], { ...options, album: items }));
  }

  /**
   * @param showChat include the chat in the header — for results spanning chats
   * @param full the whole text instead of a snippet
   * @param album every item of the message's album this result has, the message among them
   */
  message(
    first: StoredMessage,
    options: { showChat?: boolean; full?: boolean; album?: StoredMessage[] } = {},
  ): string {
    const items = [...(options.album ?? [first])].sort((a, b) => a.message_id - b.message_id);
    // The album's caption sits on one of its items, and so may its reply.
    const message: StoredMessage = {
      ...items[0],
      text: items
        .map((item) => item.text)
        .filter(Boolean)
        .join("\n"),
      reply_to_id: items.find((item) => item.reply_to_id)?.reply_to_id ?? null,
      quote: items.find((item) => item.quote)?.quote ?? null,
      mentions_bot: items.some((item) => item.mentions_bot),
    };
    const header = [
      `#${message.message_id}`,
      formatTime(message.date) + (message.edited_at ? " (edited)" : ""),
      ...(options.showChat || message.thread_id ? [this.where(message, message.thread_id)] : []),
      sender(message, this.botUsername, this.userId) +
        (message.mentions_bot && !message.outgoing && this.isGroup(message) ? " 🔔" : ""),
    ].join(" · ");

    const lines = [header];
    if (message.forwarded_from) {
      lines.push(
        `  ↪ from ${JSON.stringify(message.forwarded_from)} — forwarded, not the sender's words`,
      );
    }
    if (message.reply_to_id) {
      const target = this.replyTargets.get(`${refKey(message)}:${message.reply_to_id}`);
      lines.push(
        target
          ? `  ↩ #${target.message_id} ${sender(target, this.botUsername, this.userId)}: "${clip(target.text, REPLY_PREVIEW_LENGTH)}"`
          : `  ↩ #${message.reply_to_id} (not stored)`,
      );
    }
    if (message.quote) {
      lines.push(
        `  ❝${clip(message.quote, REPLY_PREVIEW_LENGTH)}❞ — quoted, not the sender's words`,
      );
    }

    const text = options.full ? message.text : clip(message.text, SNIPPET_LENGTH);
    if (text) {
      lines.push(...text.split("\n").map((line) => `  ${line}`));
      if (!options.full && message.text.replace(/\s+/g, " ").trim().length > SNIPPET_LENGTH) {
        lines.push("  (cut — get_message for the rest)");
      }
    }
    for (const item of items) {
      if (!item.file_id) continue;
      lines.push(
        `  📎 ${items.length > 1 ? `#${item.message_id} ` : ""}${item.file_name ?? item.file_kind} (${humanSize(item.file_size)}, ${item.file_kind}${item.file_mime ? `, ${item.file_mime}` : ""})`,
      );
    }
    if (message.album && items.length === 1 && !options.full) {
      lines.push("  (part of an album: get_message shows all of it)");
    }
    if (message.buttons) {
      const labels = (JSON.parse(message.buttons) as { text: string }[][])
        .flat()
        .map((b) => b.text);
      lines.push(`  [buttons: ${labels.join(" | ")}]`);
    }
    const link = this.link(message);
    if (link && this.isGroup(message)) lines.push(`  ${link}`);
    return this.fence.wrap(lines.join("\n"));
  }

  private isGroup(ref: ChatRef): boolean {
    return this.chats.get(refKey(ref))?.kind === "group";
  }
}

export function formatPresses(presses: PressRow[], userId: number): string {
  return presses
    .map(
      (press) =>
        `${formatTime(press.date)} ${person(press.user_name, null, press.user_id, userId)} pressed "${press.label}"` +
        (press.data !== press.label ? ` (data: ${press.data})` : ""),
    )
    .join("\n");
}

export function formatReactions(reactions: ReactionRow[], userId: number): string {
  return reactions
    .map(
      (reaction) =>
        `${reaction.emoji} ${person(reaction.user_name, null, reaction.user_id, userId)}`,
    )
    .join(", ");
}

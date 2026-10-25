/**
 * Tools that read the stored history: which chats exist, search, recent
 * messages, one message in full, and attachments.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { PERSONAL_REPLY_WINDOW, rightsOf, type ChatView } from "../access";
import { bytesToBase64, nowSeconds } from "../crypto";
import {
  attachment,
  downloadLink,
  INLINE_TEXT_CHARS,
  inlineBytes,
  isInlineImage,
  isTextual,
} from "../files";
import { Fence, formatPresses, formatReactions, formatTime, humanSize, Renderer } from "../format";
import { retentionNote } from "../prompts";
import { BOT_ACCOUNT, MAX_SCOPES, refKey, type ChatRef, type StoredMessage } from "../store";
import {
  chatArg,
  messageIdArg,
  parseTime,
  text,
  ToolError,
  toolError,
  topicArg,
  type ToolContext,
} from "./common";

const DEFAULT_LIMIT = 20;
/** How far back a search looks unless told otherwise. */
const DEFAULT_SEARCH_WINDOW = "1d";
const MAX_LIMIT = 100;
const REPLY_CHAIN_DEPTH = 5;

/**
 * A name safe to hand to a shell as an output path. The original comes from
 * whoever posted the file, so `../../.bashrc` or `-rf` must not survive.
 */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[.-]+/, "");
  return cleaned.slice(0, 120) || "file";
}

/** Words and "quoted phrases". */
export function keywords(query: string | undefined): string[] {
  if (!query) return [];
  const words: string[] = [];
  for (const match of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const word = (match[1] ?? match[2]).trim();
    if (word) words.push(word);
  }
  return words;
}

/** How a chat is named in results. */
function label(chat: ChatView): string {
  if (chat.kind === "dm") return 'chat "me"';
  if (chat.kind === "personal") return `personal chat with ${JSON.stringify(chat.title)}`;
  return JSON.stringify(chat.title);
}

/** A renderer that knows the chats, their topics, and what each message replies to. */
async function renderer(
  ctx: ToolContext,
  chats: ChatView[],
  messages: StoredMessage[],
  extra: string[] = [],
): Promise<Renderer> {
  const key = (chat: ChatRef, messageId: number) => `${refKey(chat)}:${messageId}`;
  const present = new Map(messages.map((message) => [key(message, message.message_id), message]));
  const missing = new Map<string, { chat: ChatRef; ids: number[] }>();
  for (const message of messages) {
    if (!message.reply_to_id || present.has(key(message, message.reply_to_id))) continue;
    const entry = missing.get(refKey(message)) ?? { chat: message, ids: [] };
    entry.ids.push(message.reply_to_id);
    missing.set(refKey(message), entry);
  }
  const fetched = await Promise.all(
    [...missing.values()].map(({ chat, ids }) => ctx.store.getMessages(chat, ids)),
  );
  const visibleFrom = new Map(chats.map((chat) => [refKey(chat), chat.visible_from]));
  for (const message of fetched.flat()) {
    if (message.date >= (visibleFrom.get(refKey(message)) ?? Infinity)) {
      present.set(key(message, message.message_id), message);
    }
  }
  const topics = await ctx.store.topics(
    chats.filter((chat) => chat.is_forum).map((chat) => chat.chat_id),
  );
  return new Renderer(ctx.bot.username, ctx.user, chats, topics, present, extra);
}

function nothingFound(ctx: ToolContext, what: string): string {
  return (
    `Nothing found for ${what}. ${retentionNote(ctx.config.retentionDays)} The bot only sees its private chat ` +
    "with the user, connected groups and — if the user connected it to their account — the personal chats they " +
    "gave it (list_chats), from when it joined." +
    (ctx.bot.canReadAll
      ? ""
      : " Privacy mode is on, so in groups it only sees commands, mentions and replies to it.")
  );
}

/** The personal-chats part of list_chats: what the user allowed, then each chat. */
function personalChats(
  chats: ChatView[],
  rights: ReturnType<typeof rightsOf>,
  last: Map<string, number>,
): string {
  const allowed = [
    rights.can_reply ? "send and edit messages as the user (send_as_user, edit_as_user)" : null,
    rights.can_read_messages ? "mark messages as read (mark_read)" : null,
    rights.can_delete_sent_messages ? "delete messages sent through you (delete_as_user)" : null,
  ].filter(Boolean);
  const header =
    "Personal chats — the user's own chats with other people (Telegram Business), from when they connected " +
    "the bot. You can read them. " +
    (allowed.length
      ? `The user also allowed you to: ${allowed.join(", ")} — only within ${PERSONAL_REPLY_WINDOW / 3600} h of ` +
        "the other person's last message, and only when the user asks you to in this conversation."
      : "Read only: the user has not allowed you to write or act in them, so don't.");
  if (!chats.length) return `${header}\nNo messages received yet.`;
  const lines = chats.map((chat) => {
    const seen = last.get(refKey(chat));
    return `- ${JSON.stringify(chat.title)} — chat ${chat.chat_id}${chat.username ? ` (@${chat.username})` : ""} · ${
      seen ? `last message ${formatTime(seen)} UTC` : "no messages stored"
    }`;
  });
  return `${header}\n${lines.join("\n")}`;
}

/** Personal chats can be many; a search across everything keeps the most recently active. */
async function mostRecent(ctx: ToolContext, chats: ChatView[]): Promise<ChatView[]> {
  if (chats.length <= MAX_SCOPES) return chats;
  const own = chats.filter((chat) => chat.kind !== "personal");
  const personal = chats.filter((chat) => chat.kind === "personal");
  const last = await ctx.store.lastMessageDates(personal);
  personal.sort((a, b) => (last.get(refKey(b)) ?? 0) - (last.get(refKey(a)) ?? 0));
  return [...own, ...personal].slice(0, MAX_SCOPES);
}

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_chats",
    {
      title: "Chats the bot can see",
      description:
        'The user\'s private chat with the bot ("me"), every group they connected, and their personal chats if ' +
        "they connected the bot to their account (with what they allowed there): ids, history window, forum " +
        "topics, last activity and t.me links. Call this before posting to or searching a chat by name.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const [all, connection] = await Promise.all([
          ctx.access.all(),
          ctx.store.getBusinessConnection(ctx.userId),
        ]);
        const [last, topics] = await Promise.all([
          ctx.store.lastMessageDates(all),
          ctx.store.topics(all.filter((chat) => chat.is_forum).map((chat) => chat.chat_id)),
        ]);
        const chats = all.filter((chat) => chat.kind !== "personal");
        const lines = chats.map((chat) => {
          const seen = last.get(refKey(chat));
          const parts = [
            chat.kind === "dm"
              ? 'Private chat with the bot — chat "me"'
              : `${JSON.stringify(chat.title)} — chat ${chat.chat_id}`,
            chat.kind === "dm" ? null : chat.is_forum ? "forum with topics" : chat.type,
            chat.kind === "dm"
              ? null
              : chat.visible_from === 0
                ? "all stored history"
                : `history from ${formatTime(chat.visible_from)} UTC`,
            seen ? `last message ${formatTime(seen)} UTC` : "no messages stored",
            chat.link,
          ].filter(Boolean);
          const chatTopics = topics.filter((topic) => topic.chat_id === chat.chat_id);
          const topicLine = chatTopics.length
            ? `\n  topics: ${chatTopics.map((topic) => `${topic.name} (topic ${topic.thread_id})`).join(", ")}`
            : "";
          return `- ${parts.join(" · ")}${topicLine}`;
        });
        const personal = all
          .filter((chat) => chat.kind === "personal")
          .sort((a, b) => (last.get(refKey(b)) ?? 0) - (last.get(refKey(a)) ?? 0));
        const notes = [
          `Retention: ${ctx.config.retentionDays} days.`,
          ctx.bot.canReadAll
            ? null
            : "Privacy mode is on: in groups where the bot is not an admin it sees only commands, mentions and replies to it.",
          chats.length === 1
            ? "No groups connected. The user can add the bot to a group, or send /connect to the bot."
            : null,
          `Bot: https://t.me/${ctx.bot.username}`,
        ].filter(Boolean);
        const personalSection = connection?.enabled
          ? personalChats(personal, rightsOf(connection), last)
          : "Personal chats: not connected. The user can add the bot in Telegram → Settings → Telegram Business → " +
            "Chatbots to let you read their own chats with other people.";
        return text(`${lines.join("\n")}\n\n${personalSection}\n\n${notes.join("\n")}`);
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search Telegram messages",
      description:
        "Search what the bot has stored: by keywords (all must appear; case-insensitive; any language; " +
        '"quoted phrase" for exact), sender, time, files, or only messages that tag the bot (mentions_only — ' +
        '"where did I tag you"). Default: every chat the user can see, newest first. Replies show what they ' +
        `reply to. Searches the last ${DEFAULT_SEARCH_WINDOW} unless since is given: widen it step by step ` +
        `("3d", then "7d") only when the user's question needs it — every extra day is read in full, so ` +
        `"${ctx.config.retentionDays}d" (everything stored) is the expensive last resort. The result states the ` +
        `window searched; say it when reporting "nothing found". ${retentionNote(ctx.config.retentionDays)}`,
      inputSchema: z.object({
        query: z
          .string()
          .max(300)
          .optional()
          .describe('Keywords. Substrings match: "deploy" finds "deployment".'),
        chat: chatArg.describe('Limit to one chat. Default: all chats, including "me".'),
        topic: topicArg,
        from: z.string().max(100).optional().describe("Sender: @username, name, or numeric id."),
        mentions_only: z
          .boolean()
          .optional()
          .describe("Only messages that tag, reply to, or command the bot."),
        has_file: z.boolean().optional().describe("Only messages with an attachment."),
        file_kind: z
          .enum([
            "document",
            "photo",
            "video",
            "audio",
            "voice",
            "video_note",
            "animation",
            "sticker",
          ])
          .optional(),
        sent_by: z.enum(["others", "bot", "anyone"]).optional().describe("Default: anyone."),
        since: z
          .string()
          .optional()
          .describe(
            `Start of the window: "2h", "3d", "today", or an ISO date/time (UTC). Default: "${DEFAULT_SEARCH_WINDOW}".`,
          ),
        until: z.string().optional().describe("End of the window. Default: now."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Default: ${DEFAULT_LIMIT}.`),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const available =
          args.chat === undefined ? await ctx.access.all() : [await ctx.access.resolve(args.chat)];
        const chats = await mostRecent(ctx, available);
        const limit = args.limit ?? DEFAULT_LIMIT;
        // Reads grow with the window, not the result, so the window is always
        // bounded — and always reported, so "nothing found" is never mistaken
        // for "never happened".
        const oldest = nowSeconds() - ctx.config.retentionDays * 86_400;
        const asked = parseTime(args.since ?? DEFAULT_SEARCH_WINDOW, "since")!;
        const since = Math.max(asked, oldest);
        const until = parseTime(args.until, "until");
        const window =
          `Searched ${chats.length === 1 ? label(chats[0]) : `${chats.length} chats`} ` +
          `from ${formatTime(since)} to ${until ? formatTime(until) : "now"} UTC` +
          (args.since === undefined
            ? ` (default: last ${DEFAULT_SEARCH_WINDOW}; pass since, e.g. "7d", to look further back).`
            : asked < oldest
              ? ` (asked for earlier, but nothing older than ${ctx.config.retentionDays} days is kept).`
              : ".");
        const found = await ctx.store.search({
          scopes: chats,
          keywords: keywords(args.query),
          from: args.from,
          mentionsOnly: args.mentions_only,
          hasFile: args.has_file,
          fileKind: args.file_kind,
          threadId: args.topic,
          direction:
            args.sent_by === "others" ? "incoming" : args.sent_by === "bot" ? "outgoing" : "any",
          since,
          until,
          limit,
        });

        const what =
          [
            args.query ? `"${args.query}"` : null,
            args.mentions_only ? "mentions of the bot" : null,
            args.from ? `from ${args.from}` : null,
            args.has_file || args.file_kind ? "with files" : null,
            args.since ? `since ${args.since}` : null,
          ]
            .filter(Boolean)
            .join(", ") || "that filter";
        if (!found.length) return text(`${window}\n${nothingFound(ctx, what)}`);

        const render = await renderer(ctx, chats, found);
        const body = render.messages(found, { showChat: chats.length > 1 }).join("\n\n");
        const more =
          found.length === limit
            ? `\n\n(${limit} shown; more may exist — narrow with since/until/chat or raise limit.)`
            : "";
        const truncated =
          available.length > chats.length
            ? `\n(Searched the ${chats.length} most recently active of ${available.length} chats; pass chat to search another.)`
            : "";
        return text(
          `${window}\n${found.length} message${found.length === 1 ? "" : "s"}, newest first. Times are UTC.\n${render.fence.note()}\n\n${body}${more}${truncated}`,
        );
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "get_recent_messages",
    {
      title: "Recent messages in a chat",
      description:
        'The latest messages of one chat — "me" by default, so this is the first call for "I sent you X in ' +
        'Telegram". With around_message_id, the messages just before and after one message: use it to gather ' +
        "context around a mention or reply. Oldest first.",
      inputSchema: z.object({
        chat: chatArg,
        topic: topicArg,
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Default: ${DEFAULT_LIMIT}.`),
        since: z.string().optional().describe('"2h", "3d", "today", or an ISO date/time (UTC).'),
        around_message_id: messageIdArg.optional().describe("Centre the window on this message."),
        before_message_id: messageIdArg
          .optional()
          .describe("Page back: messages older than this one."),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        const limit = args.limit ?? DEFAULT_LIMIT;
        let messages: StoredMessage[];
        if (args.around_message_id) {
          const half = Math.max(1, Math.floor(limit / 2));
          const [before, after] = await Promise.all([
            ctx.store.recent(chat, {
              limit: half + 1,
              beforeId: args.around_message_id + 1,
              threadId: args.topic,
            }),
            ctx.store.after(chat, args.around_message_id, half, args.topic),
          ]);
          messages = [...before.reverse(), ...after];
        } else {
          messages = (
            await ctx.store.recent(chat, {
              limit,
              beforeId: args.before_message_id,
              since: parseTime(args.since, "since"),
              threadId: args.topic,
            })
          ).reverse();
        }
        if (!messages.length) return text(nothingFound(ctx, label(chat)));

        const render = await renderer(ctx, [chat], messages);
        const heading = `${chat.kind === "dm" ? "Private chat with the bot" : chat.kind === "personal" ? `Personal chat with ${JSON.stringify(chat.title)}` : JSON.stringify(chat.title)}${
          args.topic ? ` › ${render.topicName(chat.chat_id, args.topic)}` : ""
        } — ${messages.length} message${messages.length === 1 ? "" : "s"}, oldest first, UTC.\n${render.fence.note()}`;
        const older = `\n\n(Older: before_message_id ${messages[0].message_id}.)`;
        return text(`${heading}\n\n${render.messages(messages).join("\n\n")}${older}`);
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "get_message",
    {
      title: "One message in full",
      description:
        "One message with its whole text, the chain of messages it replies to, button presses and reactions on " +
        "it, and its attachment. Use after a search or listing cut a message short, or to follow a reply.",
      inputSchema: z.object({ message_id: messageIdArg, chat: chatArg }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        const message = await ctx.store.getMessage(chat, args.message_id);
        if (!message || message.date < chat.visible_from) {
          return text(nothingFound(ctx, `message #${args.message_id} in that chat`));
        }

        const chain: StoredMessage[] = [];
        let cursor = message;
        while (cursor.reply_to_id && chain.length < REPLY_CHAIN_DEPTH) {
          const parent = await ctx.store.getMessage(chat, cursor.reply_to_id);
          if (!parent || parent.date < chat.visible_from) break;
          chain.push(parent);
          cursor = parent;
        }
        // Buttons and reactions are recorded only on the bot's own messages.
        const own = chat.account_id === BOT_ACCOUNT;
        const [presses, reactions] = await Promise.all([
          own ? ctx.store.pressesFor(chat.chat_id, message.message_id) : [],
          own ? ctx.store.reactionsFor(chat.chat_id, message.message_id) : [],
        ]);

        const album = (await ctx.store.albumOf(message)).filter(
          (item) => item.date >= chat.visible_from,
        );
        const presented = formatPresses(presses, ctx.userId);
        const reacted = formatReactions(reactions, ctx.userId);
        const render = await renderer(ctx, [chat], [...album, ...chain], [presented, reacted]);
        const parts = [render.fence.note(), render.message(message, { full: true, album })];
        const files = album.filter((item) => item.file_id).map((item) => item.message_id);
        if (files.length === 1) {
          parts.push(`Attachment: get_file with message_id ${files[0]} to read or download it.`);
        } else if (files.length) {
          parts.push(`Attachments: get_file with message_id ${files.join(", ")} — one call each.`);
        }
        if (presses.length) {
          parts.push(`Button presses:\n${render.fence.wrap(presented)}`);
        }
        if (reactions.length) {
          parts.push(`Reactions:\n${render.fence.wrap(reacted)}`);
        }
        if (chain.length) {
          parts.push(
            `Replying to (nearest first):\n\n${chain.map((parent) => render.message(parent)).join("\n\n")}`,
          );
        }
        return text(parts.join("\n\n"));
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "get_file",
    {
      title: "Read or download an attachment",
      description:
        "An attachment from a stored message. Returns a download link (15 min) to fetch with curl when you have a " +
        "shell, and the content itself for images up to 1.5 MB and the start of text files up to 1 MB. Telegram lets bots fetch " +
        "files up to 20 MB.",
      inputSchema: z.object({ message_id: messageIdArg, chat: chatArg }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        const message = await attachment(ctx, chat.chat_id, args.message_id).catch(
          (error: unknown) => {
            throw error instanceof Error ? new ToolError(error.message) : error;
          },
        );
        const link = await downloadLink(ctx, message);
        const name = message.file_name ?? message.file_kind ?? "file";
        const bytes = await inlineBytes(ctx, message).catch(() => null);
        const content = bytes && isTextual(message) ? new TextDecoder().decode(bytes) : null;
        const fence = new Fence(ctx.user, [name, message.file_mime ?? "", content ?? ""]);
        const info =
          `${fence.note()}\n` +
          fence.wrap(
            `${name} — ${humanSize(message.file_size)}, ${message.file_kind}${message.file_mime ? `, ${message.file_mime}` : ""}.`,
          ) +
          `\nDownload (valid 15 min): curl -sS --fail-with-body -o '${safeFilename(name)}' '${link}'`;

        if (!bytes) {
          return text(
            `${info}\n\n${message.file_size && message.file_size > 20 * 1024 * 1024 ? "Too big for bots to download (over 20 MB)." : "Not inlined (too big, or not text/image): use the link."}`,
          );
        }
        if (isInlineImage(message)) {
          return {
            content: [
              { type: "text" as const, text: info },
              {
                type: "image" as const,
                data: bytesToBase64(bytes),
                mimeType: message.file_mime ?? "image/jpeg",
              },
            ],
          };
        }
        if (content !== null) {
          const cut = content.length > INLINE_TEXT_CHARS;
          return text(
            `${info}\n\nContent${cut ? ` (first ${INLINE_TEXT_CHARS} characters of ${content.length}; download for the rest)` : ""}:\n` +
              fence.wrap(content.slice(0, INLINE_TEXT_CHARS)),
          );
        }
        return text(info);
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );
}

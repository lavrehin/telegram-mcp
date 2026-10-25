/**
 * Tools that post to Telegram: messages, questions with buttons, files,
 * albums, locations, polls and the "typing…" indicator.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { telegramChat, type ChatView } from "../access";
import { uploadLink } from "../files";
import { Fence, formatTime, person } from "../format";
import { GROUP_NOTE, type UserRef } from "../prompts";
import type { PressRow, StoredMessage } from "../store";
import type { Message } from "../telegram/types";
import {
  asBot,
  buttonsArg,
  chatArg,
  formatArg,
  mayPost,
  messageIdArg,
  notPersonal,
  recordSent,
  sendText,
  sendUpload,
  sentLink,
  sessionArg,
  text,
  ToolError,
  toolError,
  topicArg,
  UPLOAD_KINDS,
  where,
  type ToolContext,
} from "./common";

const WAIT_MAX_SECONDS = 50;
const WAIT_POLL_MS = 2000;
const INLINE_FILE_BYTES = 1024 * 1024;

export const silentArg = z.boolean().optional().describe("Deliver without a notification sound.");
export const replyToArg = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Reply to this message id.");

/** File content passed inline, as text or base64; at most 1 MB. */
export function inlineBytes(content: { text?: string; content_base64?: string }): Uint8Array {
  if ((content.text === undefined) === (content.content_base64 === undefined)) {
    throw new ToolError("Pass exactly one of text or content_base64.");
  }
  let bytes: Uint8Array;
  if (content.text !== undefined) {
    bytes = new TextEncoder().encode(content.text);
  } else {
    try {
      const binary = atob(
        content.content_base64!.replace(/\s+/g, "").replaceAll("-", "+").replaceAll("_", "/"),
      );
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
      throw new ToolError("content_base64 is not valid base64.");
    }
  }
  if (bytes.byteLength > INLINE_FILE_BYTES) {
    throw new ToolError(
      `That is ${bytes.byteLength} bytes; inline files stop at 1 MB. Use an upload link.`,
    );
  }
  if (!bytes.byteLength) throw new ToolError("The file is empty.");
  return bytes;
}

/** What create_upload_url (and its as-user counterpart) hands back. */
export function uploadInstructions(filename: string, chat: ChatView, url: string): string {
  const quoted = `'${url.replaceAll("'", "'\\''")}'`;
  return (
    `Upload link for ${filename} → ${where(chat)}, valid 10 minutes, single use:\n${url}\n\n` +
    `Run:\ncurl -sS --fail-with-body -T <path-to-file> ${quoted}\n\n` +
    "It prints where the file was sent. Do not show this link to the user."
  );
}

export function sentSummary(ctx: ToolContext, chat: ChatView, messages: Message[]): string {
  const ids = messages.map((message) => `#${message.message_id}`).join(", ");
  const link = messages.length ? sentLink(ctx, chat, messages.at(-1)!) : null;
  return `Sent to ${where(chat)} as ${ids}.${link ? ` Link for the user: ${link}` : ""}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Answer = { kind: "press"; press: PressRow } | { kind: "message"; message: StoredMessage };

/**
 * Wait for an answer to one of the bot's messages: a press on its buttons, a
 * reply to it, or — in the private chat — anything the user writes after it.
 * Polls D1: a couple of row reads per round, no writes per round.
 */
async function waitForAnswer(
  ctx: ToolContext,
  chat: ChatView,
  messageId: number,
  seconds: number,
): Promise<Answer | null> {
  const deadline = Date.now() + seconds * 1000;
  await ctx.store.markAwaited(chat, messageId, Math.ceil(deadline / 1000), "start");
  for (;;) {
    const answer = await findAnswer(ctx, chat, messageId);
    if (answer) {
      // The session stops listening now, not at the deadline.
      await ctx.store.markAwaited(chat, messageId, Math.floor(Date.now() / 1000), "end");
      return answer;
    }
    if (Date.now() + WAIT_POLL_MS > deadline) return null;
    await sleep(WAIT_POLL_MS);
  }
}

async function findAnswer(
  ctx: ToolContext,
  chat: ChatView,
  messageId: number,
): Promise<Answer | null> {
  const presses = await ctx.store.pressesFor(chat.chat_id, messageId);
  if (presses.length) return { kind: "press", press: presses[0] };
  const answer = await ctx.store.answerTo(chat, messageId, chat.kind === "dm" ? ctx.userId : null);
  return answer ? { kind: "message", message: answer } : null;
}

function describeAnswer(
  answer: Answer | null,
  messageId: number,
  seconds: number,
  user: UserRef,
): string {
  if (!answer) {
    return (
      `No answer to #${messageId} within ${seconds} s. The user may be away: call wait_for_reply again ` +
      "to keep waiting, or carry on with work that does not depend on the answer. Do not assume one."
    );
  }
  if (answer.kind === "press") {
    const { press } = answer;
    const value = press.data !== press.label ? ` (value: ${press.data})` : "";
    const who = person(press.user_name, null, press.user_id, user.id);
    const body = `${who} pressed "${press.label}"${value} at ${formatTime(press.date)} UTC.`;
    const fence = new Fence(user, [body]);
    return `${fence.note()}\n${fence.wrap(body)}`;
  }
  const message = answer.message;
  const who = person(message.from_name, message.from_username, message.from_id, user.id);
  const file = message.file_id
    ? `\n[attachment: ${message.file_name ?? message.file_kind} — get_file chat ${message.chat_id} message ${message.message_id}]`
    : "";
  const body = `${who}: ${message.text}${file}`;
  const fence = new Fence(user, [body]);
  return (
    `Answer #${message.message_id}, ${formatTime(message.date)} UTC. ${fence.note()}\n` +
    fence.wrap(body)
  );
}

export function registerSendTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "send_message",
    {
      title: "Send a Telegram message",
      description:
        'Message the user in Telegram — chat "me" by default — or a connected group. Use for "message me / ' +
        'ping me when done / tell me in Telegram". Markdown is converted; long text is split. Optional buttons ' +
        "(presses are recorded) and reply_to. Returns the message id and a t.me link to give the user. For a " +
        `question that needs an answer, use ask_user instead. ${GROUP_NOTE}`,
      inputSchema: z.object({
        text: z.string().min(1).max(20_000),
        chat: chatArg,
        format: formatArg,
        buttons: buttonsArg,
        reply_to: replyToArg,
        topic: topicArg,
        silent: silentArg,
        session: sessionArg,
        link_preview: z
          .boolean()
          .optional()
          .describe("Show a preview for the first link. Default: off."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        asBot(chat, "send_as_user");
        const sent = await sendText(ctx, chat, {
          text: args.text,
          format: args.format,
          buttons: args.buttons,
          replyTo: args.reply_to,
          topic: args.topic,
          silent: args.silent,
          linkPreview: args.link_preview,
          session: args.session,
        });
        return text(sentSummary(ctx, chat, sent));
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "ask_user",
    {
      title: "Ask the user in Telegram and wait",
      description:
        "Ask a question in Telegram with answer buttons, then wait for the press or a typed reply. Use when " +
        'you need a decision and the user may not be watching this conversation ("ask me in Telegram before ' +
        `deploying"). Waits up to ${WAIT_MAX_SECONDS} s; if nothing comes, call wait_for_reply with the returned ` +
        "message id. Never act as if an answer came when it did not.",
      inputSchema: z.object({
        question: z.string().min(1).max(4000),
        options: z
          .array(z.string().min(1).max(64))
          .max(10)
          .optional()
          .describe(
            'Short answer labels, one button each, e.g. ["Deploy", "Wait"]. Omit for a free-text answer.',
          ),
        chat: chatArg,
        topic: topicArg,
        session: sessionArg,
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(WAIT_MAX_SECONDS)
          .optional()
          .describe(`How long to wait now. Default: ${WAIT_MAX_SECONDS}. 0 sends without waiting.`),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        notPersonal(chat, "ask_user asks the user, in their chat with the bot or a group.");
        const options = args.options ?? [];
        // Short labels share rows; long ones get a row each.
        const perRow = options.every((option) => option.length <= 12) ? 3 : 1;
        const buttons = [];
        for (let i = 0; i < options.length; i += perRow) {
          buttons.push(options.slice(i, i + perRow).map((option) => ({ text: option })));
        }
        const [message] = await sendText(ctx, chat, {
          text: args.question,
          buttons: buttons.length ? buttons : undefined,
          topic: args.topic,
          markChoice: true,
          session: args.session,
        }).then((sent) => sent.slice(-1));

        const seconds = args.wait_seconds ?? WAIT_MAX_SECONDS;
        const sentNote = sentSummary(ctx, chat, [message]);
        if (seconds === 0)
          return text(
            `${sentNote} Not waiting; use wait_for_reply with message_id ${message.message_id}.`,
          );
        const answer = await waitForAnswer(ctx, chat, message.message_id, seconds);
        return text(
          `${sentNote}\n${describeAnswer(answer, message.message_id, seconds, ctx.user)}`,
        );
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "wait_for_reply",
    {
      title: "Wait for the user's answer",
      description:
        "Wait for an answer to a message the bot sent: a button press, a reply to it, or (in the private chat) " +
        `anything the user writes after it. Returns as soon as one arrives, or after up to ${WAIT_MAX_SECONDS} s ` +
        'with "no answer yet". Without message_id, waits on the bot\'s latest message in that chat.',
      inputSchema: z.object({
        chat: chatArg,
        message_id: messageIdArg.optional(),
        wait_seconds: z.number().int().min(1).max(WAIT_MAX_SECONDS).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        notPersonal(chat, "to see whether someone answered there, use get_recent_messages.");
        const messageId = args.message_id ?? (await ctx.store.lastOutgoing(chat))?.message_id;
        if (!messageId)
          throw new ToolError(
            "The bot has sent nothing in that chat yet, so there is nothing to wait on.",
          );
        const seconds = args.wait_seconds ?? WAIT_MAX_SECONDS;
        return text(
          describeAnswer(
            await waitForAnswer(ctx, chat, messageId, seconds),
            messageId,
            seconds,
            ctx.user,
          ),
        );
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  const fileOptions = {
    chat: chatArg,
    caption: z.string().max(1024).optional().describe("Text under the file (Markdown)."),
    as: z
      .enum(UPLOAD_KINDS)
      .optional()
      .describe(
        "document (default, any file, keeps the name), photo (compressed, ≤10 MB), video, audio, voice, animation.",
      ),
    buttons: buttonsArg,
    reply_to: replyToArg,
    topic: topicArg,
    silent: silentArg,
    session: sessionArg,
  };

  server.registerTool(
    "create_upload_url",
    {
      title: "Get a link to upload a file to Telegram",
      description:
        "The way to send a file you built when you have a shell: returns a one-time URL (valid 10 min) and the " +
        "curl command to run. The file is sent to the chat the moment the upload finishes, up to 50 MB, and curl " +
        `prints the message link. Prefer this over send_file for anything but small text. ${GROUP_NOTE}`,
      inputSchema: z.object({
        filename: z.string().min(1).max(200).describe("Name the user sees, with extension."),
        ...fileOptions,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        asBot(chat, "send_as_user with file.upload");
        await mayPost(ctx, chat, args.buttons);
        const url = await uploadLink(ctx, chat, args.filename, {
          as: args.as,
          caption: args.caption,
          buttons: args.buttons,
          replyTo: args.reply_to,
          topic: args.topic,
          silent: args.silent,
          session: args.session,
        });
        return text(uploadInstructions(args.filename, chat, url));
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "send_file",
    {
      title: "Send a small file inline",
      description:
        "Send a file whose content you pass directly: `text` for text files (code, logs, CSV, Markdown), or " +
        "`content_base64` for small binaries (≤1 MB). Use when you have no shell; otherwise create_upload_url " +
        `is cheaper and handles big files. ${GROUP_NOTE}`,
      inputSchema: z.object({
        filename: z.string().min(1).max(200),
        text: z.string().optional().describe("File content as text (UTF-8)."),
        content_base64: z.string().optional().describe("File content as base64, ≤1 MB decoded."),
        ...fileOptions,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        asBot(chat, "send_as_user with file");
        const bytes = inlineBytes(args);
        const message = await sendUpload(ctx, chat, { blob: new Blob([bytes]) }, args.filename, {
          as: args.as,
          caption: args.caption,
          buttons: args.buttons,
          replyTo: args.reply_to,
          topic: args.topic,
          silent: args.silent,
          session: args.session,
        });
        return text(sentSummary(ctx, chat, [message]));
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "send_album",
    {
      title: "Send several photos or files as one album",
      description:
        "Group 2–10 photos/videos (or 2–10 documents) into one album. Items are files already in Telegram — " +
        "attachments of stored messages, by message id — or public URLs Telegram can fetch. To upload new files, " +
        `send them one by one with create_upload_url. ${GROUP_NOTE}`,
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              message_id: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("A stored message with a photo/video/document."),
              from_chat: chatArg.describe('Chat of that message. Default: "me".'),
              url: z.string().url().optional().describe("Or a public https URL."),
              kind: z
                .enum(["photo", "video", "document"])
                .optional()
                .describe("For URLs. Default: photo."),
              caption: z.string().max(1024).optional(),
            }),
          )
          .min(2)
          .max(10),
        chat: chatArg,
        topic: topicArg,
        silent: silentArg,
        session: sessionArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        asBot(chat, "send_as_user, one file at a time");
        await mayPost(ctx, chat);
        const media = [];
        for (const item of args.items) {
          if (item.message_id) {
            const from = await ctx.access.resolve(item.from_chat);
            notPersonal(from, "the bot cannot carry a personal chat's files elsewhere.");
            const stored = await ctx.store.getMessage(from, item.message_id);
            if (!stored?.file_id || stored.date < from.visible_from) {
              throw new ToolError(`Message #${item.message_id} has no stored attachment.`);
            }
            const kind = stored.file_kind ?? "";
            if (!["photo", "video", "document", "audio"].includes(kind)) {
              throw new ToolError(
                `Message #${item.message_id} holds a ${kind}; albums take photos, videos, documents or audio only.`,
              );
            }
            media.push({ type: kind, media: stored.file_id, caption: item.caption });
          } else if (item.url) {
            media.push({ type: item.kind ?? "photo", media: item.url, caption: item.caption });
          } else {
            throw new ToolError("Each item needs message_id or url.");
          }
        }
        const sent = await ctx.api.call<Message[]>("sendMediaGroup", {
          ...telegramChat(chat),
          media,
          ...(args.topic ? { message_thread_id: args.topic } : {}),
          ...(args.silent ? { disable_notification: true } : {}),
        });
        for (const message of sent) await recordSent(ctx, chat, message, { session: args.session });
        return text(sentSummary(ctx, chat, sent));
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "send_location",
    {
      title: "Send a map pin",
      description: `Send a location pin, optionally as a named venue. ${GROUP_NOTE}`,
      inputSchema: z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        title: z
          .string()
          .max(100)
          .optional()
          .describe("Venue name; with address, sends a venue card."),
        address: z.string().max(200).optional(),
        chat: chatArg,
        topic: topicArg,
        session: sessionArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        asBot(chat, "send_as_user with the address as text");
        await mayPost(ctx, chat);
        const venue = args.title && args.address;
        const message = await ctx.api.call<Message>(venue ? "sendVenue" : "sendLocation", {
          ...telegramChat(chat),
          latitude: args.latitude,
          longitude: args.longitude,
          ...(venue ? { title: args.title, address: args.address } : {}),
          ...(args.topic ? { message_thread_id: args.topic } : {}),
        });
        await recordSent(ctx, chat, message, {
          text: venue ? `[venue] ${args.title}, ${args.address}` : undefined,
          session: args.session,
        });
        return text(sentSummary(ctx, chat, [message]));
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "send_poll",
    {
      title: "Start a poll",
      description:
        'Post a native Telegram poll, typically in a group ("poll the team on Friday vs Monday"). Votes are ' +
        `not reported back to you; for one person's decision, use ask_user. ${GROUP_NOTE}`,
      inputSchema: z.object({
        question: z.string().min(1).max(300),
        options: z.array(z.string().min(1).max(100)).min(2).max(12),
        anonymous: z.boolean().optional().describe("Default: false — voters are visible."),
        multiple_answers: z.boolean().optional(),
        chat: chatArg,
        topic: topicArg,
        session: sessionArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        asBot(chat, "send_as_user with the question as text");
        await mayPost(ctx, chat);
        const message = await ctx.api.call<Message>("sendPoll", {
          ...telegramChat(chat),
          question: args.question,
          options: args.options.map((option) => ({ text: option })),
          is_anonymous: args.anonymous ?? false,
          allows_multiple_answers: args.multiple_answers ?? false,
          ...(args.topic ? { message_thread_id: args.topic } : {}),
        });
        await recordSent(ctx, chat, message, { session: args.session });
        return text(sentSummary(ctx, chat, [message]));
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "send_chat_action",
    {
      title: 'Show "typing…"',
      description:
        'Show "typing…" (or "sending a document…") in the chat for ~5 s, before a send that takes a while. Optional nicety.',
      inputSchema: z.object({
        action: z
          .enum([
            "typing",
            "upload_document",
            "upload_photo",
            "upload_video",
            "record_voice",
            "find_location",
          ])
          .optional(),
        chat: chatArg,
        topic: topicArg,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        notPersonal(chat, "the other person would see the user typing.");
        await ctx.api.call("sendChatAction", {
          ...telegramChat(chat),
          action: args.action ?? "typing",
          ...(args.topic ? { message_thread_id: args.topic } : {}),
        });
        return text("Shown.");
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );
}

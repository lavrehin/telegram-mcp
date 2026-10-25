/**
 * Tools that act as the user, in their personal chats (Telegram Business):
 * send, edit, delete, mark as read. The other person cannot tell any of it
 * from the user's own doing, so these are kept apart from the bot's tools:
 * a client can let the bot speak freely and still ask before these run.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { telegramChat, type ChatView } from "../access";
import { uploadLink } from "../files";
import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_TEXT_LIMIT } from "../markdown";
import { AS_USER_NOTE } from "../prompts";
import { editMessage, ownMessage } from "./edit";
import { inlineBytes, replyToArg, sentSummary, silentArg, uploadInstructions } from "./send";
import {
  formatArg,
  mayPost,
  messageIdArg,
  sendText,
  sendUpload,
  sessionArg,
  text,
  ToolError,
  toolError,
  UPLOAD_KINDS,
  type ToolContext,
} from "./common";

const personalArg = z
  .union([z.string(), z.number()])
  .describe("A personal chat from list_chats: name, @username or id.");

const AS_USER = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
} as const;

async function personalChat(
  ctx: ToolContext,
  arg: string | number,
  tool: string,
  instead?: string,
): Promise<ChatView> {
  const chat = await ctx.access.resolve(arg);
  if (chat.kind !== "personal") {
    throw new ToolError(
      `${tool} is for the user's personal chats (list_chats shows them).` +
        (instead ? ` In the bot's own chats, use ${instead}.` : ""),
    );
  }
  return chat;
}

export function registerPersonalTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "send_as_user",
    {
      title: "Send as the user",
      description:
        `${AS_USER_NOTE} Sends text, or a file with the text as its caption: inline (text or base64, ≤1 MB), ` +
        "or with file.upload a one-time link to curl a bigger one to.",
      inputSchema: z.object({
        chat: personalArg,
        text: z.string().max(20_000).optional().describe("The message, or the file's caption."),
        format: formatArg,
        reply_to: replyToArg,
        silent: silentArg,
        file: z
          .object({
            filename: z.string().min(1).max(200),
            text: z.string().optional().describe("File content as text (UTF-8)."),
            content_base64: z
              .string()
              .optional()
              .describe("File content as base64, ≤1 MB decoded."),
            upload: z
              .boolean()
              .optional()
              .describe("Instead of content: return an upload link (10 min, up to 50 MB)."),
            as: z.enum(UPLOAD_KINDS).optional().describe("document (default), photo, video…"),
          })
          .optional(),
        session: sessionArg,
      }),
      annotations: AS_USER,
    },
    async (args) => {
      try {
        const chat = await personalChat(ctx, args.chat, "send_as_user", "send_message");
        const options = {
          as: args.file?.as,
          caption: args.text,
          format: args.format,
          replyTo: args.reply_to,
          silent: args.silent,
          session: args.session,
        };
        if (args.file && args.text && args.text.length > TELEGRAM_CAPTION_LIMIT) {
          throw new ToolError(
            `With a file, text is its caption, and captions stop at ${TELEGRAM_CAPTION_LIMIT} characters.`,
          );
        }
        if (args.file?.upload) {
          if (args.file.text !== undefined || args.file.content_base64 !== undefined) {
            throw new ToolError("Pass the content or upload: true, not both.");
          }
          await mayPost(ctx, chat);
          const url = await uploadLink(ctx, chat, args.file.filename, options);
          return text(uploadInstructions(args.file.filename, chat, url));
        }
        if (args.file) {
          const bytes = inlineBytes(args.file);
          const message = await sendUpload(
            ctx,
            chat,
            { blob: new Blob([bytes]) },
            args.file.filename,
            options,
          );
          return text(sentSummary(ctx, chat, [message]));
        }
        if (!args.text) throw new ToolError("Pass text, a file, or both.");
        const sent = await sendText(ctx, chat, {
          text: args.text,
          format: args.format,
          replyTo: args.reply_to,
          silent: args.silent,
          session: args.session,
        });
        return text(sentSummary(ctx, chat, sent));
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "edit_as_user",
    {
      title: "Edit a message sent as the user",
      description: `${AS_USER_NOTE} Changes the text (or caption) of a message sent through you; never one the user typed.`,
      inputSchema: z.object({
        chat: personalArg,
        message_id: messageIdArg,
        text: z.string().min(1).max(TELEGRAM_TEXT_LIMIT),
        format: formatArg,
      }),
      annotations: { ...AS_USER, idempotentHint: true },
    },
    async (args) => {
      try {
        const chat = await personalChat(ctx, args.chat, "edit_as_user", "edit_message");
        await editMessage(ctx, chat, args);
        return text(`Edited #${args.message_id}.`);
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "delete_as_user",
    {
      title: "Delete a message sent as the user",
      description:
        `${AS_USER_NOTE} Deletes a message sent through you (never one the user typed), if the user allowed ` +
        "deleting in Telegram; within 48 hours.",
      inputSchema: z.object({ chat: personalArg, message_id: messageIdArg }),
      annotations: { ...AS_USER, idempotentHint: true },
    },
    async (args) => {
      try {
        const chat = await personalChat(ctx, args.chat, "delete_as_user", "delete_message");
        await ownMessage(ctx, chat, args.message_id);
        await ctx.access.allow(chat, "delete");
        await ctx.api.call("deleteBusinessMessages", {
          business_connection_id: telegramChat(chat).business_connection_id,
          message_ids: [args.message_id],
        });
        await ctx.store.deleteMessages(chat, [args.message_id]);
        return text(`Deleted #${args.message_id}.`);
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "mark_read",
    {
      title: "Mark a personal chat as read",
      description:
        "Mark a message in one of the user's personal chats as read (default: the other person's latest). They " +
        'will see it as read by the user, so do it only when the user asks. Needs the "Mark messages as read" ' +
        "permission the user gives in Telegram.",
      inputSchema: z.object({
        chat: personalArg,
        message_id: messageIdArg.optional(),
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
        const chat = await personalChat(ctx, args.chat, "mark_read");
        await ctx.access.allow(chat, "read");
        const messageId = args.message_id ?? (await ctx.store.lastIncoming(chat))?.message_id;
        if (!messageId)
          throw new ToolError("No stored messages from the other person in that chat.");
        await ctx.api.call("readBusinessMessage", { ...telegramChat(chat), message_id: messageId });
        return text(`Marked as read up to #${messageId}.`);
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );
}

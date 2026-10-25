/**
 * Files in and out without base64 through the model.
 *
 *   PUT /upload/<signed>   the body is sent to Telegram as a file message
 *   GET /file/<signed>     an attachment, streamed from Telegram
 *
 * Both links are signed blobs naming the user, the chat and (for downloads)
 * the message, and both re-check access when used — a link outliving a
 * revoke is worthless. An upload link works once (its nonce is recorded) and
 * for ten minutes; a download link for fifteen. Nothing is stored here:
 * uploads go straight on to Telegram, downloads come straight from it.
 */

import { AccessError, type ChatView } from "./access";
import { randomId, sign, verify } from "./crypto";
import { isAllowed } from "./env";
import { humanSize } from "./format";
import { allow, clientIp, tooManyRequests } from "./limits";
import type { StoredMessage } from "./store";
import {
  MAX_DOWNLOAD_BYTES,
  MAX_PHOTO_BYTES,
  MAX_UPLOAD_BYTES,
  TelegramError,
} from "./telegram/api";
import {
  sendUpload,
  mayPost,
  sentLink,
  ToolError,
  where,
  type Buttons,
  type FileSendOptions,
  type ToolContext,
  type UploadKind,
} from "./tools/common";

const UPLOAD_TTL = 10 * 60;
const DOWNLOAD_TTL = 15 * 60;

/** Inline content is returned with get_file up to these sizes. */
const INLINE_TEXT_BYTES = 1024 * 1024;
const INLINE_IMAGE_BYTES = 1536 * 1024;
/** Text handed to the model is cut here; a tool result much larger than this is useless to it. */
export const INLINE_TEXT_CHARS = 60_000;

interface UploadBlob {
  u: number;
  /** The user's token version when the link was made. */
  v: number;
  c: number;
  f: string;
  n: string;
  cap?: string;
  fmt?: "markdown" | "plain";
  as?: UploadKind;
  b?: Buttons;
  r?: number;
  t?: number;
  s?: boolean;
  /** The sending Claude Code session. */
  ss?: string;
  /** Made for a personal chat, by send_as_user: such a link sends as the user, nothing else does. */
  p?: boolean;
}

interface FileBlob {
  u: number;
  v: number;
  c: number;
  m: number;
}

export async function uploadLink(
  ctx: ToolContext,
  chat: ChatView,
  filename: string,
  options: FileSendOptions,
): Promise<string> {
  const blob = await sign<UploadBlob>(
    ctx.config.signingKey,
    "upload",
    {
      u: ctx.userId,
      v: (await ctx.store.getUser(ctx.userId))?.token_version ?? 0,
      c: chat.chat_id,
      f: filename,
      n: randomId(),
      cap: options.caption,
      fmt: options.format,
      as: options.as,
      b: options.buttons,
      r: options.replyTo,
      t: options.topic,
      s: options.silent,
      ss: options.session,
      p: chat.kind === "personal" || undefined,
    },
    UPLOAD_TTL,
  );
  return `${ctx.origin}/upload/${blob}`;
}

export async function downloadLink(ctx: ToolContext, message: StoredMessage): Promise<string> {
  const blob = await sign<FileBlob>(
    ctx.config.signingKey,
    "file",
    {
      u: ctx.userId,
      v: (await ctx.store.getUser(ctx.userId))?.token_version ?? 0,
      c: message.chat_id,
      m: message.message_id,
    },
    DOWNLOAD_TTL,
  );
  const name = encodeURIComponent(message.file_name ?? `${message.file_kind}`);
  return `${ctx.origin}/file/${blob}/${name}`;
}

function plain(body: string, status: number): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * A link stops working the moment its user may no longer connect: removed
 * from the allowlist, or signed out with /disconnect (token version bumped).
 */
async function stillValid(ctx: ToolContext, userId: number, version: number | undefined) {
  if (!isAllowed(ctx.config, userId)) return false;
  const user = await ctx.store.getUser(userId);
  return (user?.token_version ?? 0) === (version ?? 0);
}

export type ToolContextFor = (userId: number) => Promise<ToolContext>;

export async function handleUpload(
  request: Request,
  limiter: RateLimit | undefined,
  contextFor: ToolContextFor,
  signingKey: CryptoKey,
): Promise<Response> {
  if (request.method !== "PUT" && request.method !== "POST") {
    return plain("Upload with PUT, e.g. curl -T ./file '<this url>'", 405);
  }
  if (!(await allow(limiter, clientIp(request)))) return tooManyRequests("Too many uploads.");

  const token = new URL(request.url).pathname.slice("/upload/".length).split("/")[0];
  const link = await verify<UploadBlob>(signingKey, "upload", token);
  if (!link) return plain("This upload link is invalid or expired. Ask for a new one.", 403);

  const ctx = await contextFor(link.u);
  if (!(await stillValid(ctx, link.u, link.v))) {
    return plain("This upload link was revoked. Ask for a new one.", 403);
  }
  let chat: ChatView;
  try {
    chat = await ctx.access.resolve(link.c);
    if ((chat.kind === "personal") !== (link.p === true)) {
      return plain("This upload link is not for that chat. Ask for a new one.", 403);
    }
    // Rights can change within the link's life; check before the nonce is spent.
    await mayPost(ctx, chat, link.b);
  } catch (error) {
    if (error instanceof AccessError || error instanceof ToolError)
      return plain(error.message, 403);
    throw error;
  }

  // The size must be known up front: the file is streamed on to Telegram,
  // never held in memory, and the outgoing request needs its length.
  const declared = request.headers.get("content-length");
  const size = declared === null ? Number.NaN : Number(declared);
  if (!request.body || !Number.isSafeInteger(size)) {
    return plain("Send the file with its size, as curl does: curl -T ./file '<this url>'", 411);
  }
  if (size === 0) return plain("Empty body. Send the file: curl -T ./file '<this url>'", 400);
  const limit = link.as === "photo" ? MAX_PHOTO_BYTES : MAX_UPLOAD_BYTES;
  if (size > limit) {
    return plain(
      `Too large. Telegram accepts up to ${humanSize(limit)} for a ${link.as ?? "document"}.`,
      413,
    );
  }

  // Spent before sending: a stream cannot be retried, and a half-sent upload must not repeat.
  if (!(await ctx.store.useNonce(link.n, (link.exp ?? 0) + 60))) {
    return plain("This upload link was already used. Ask for a new one.", 409);
  }

  try {
    const type = request.headers.get("content-type") ?? "application/octet-stream";
    const message = await sendUpload(
      ctx,
      chat,
      {
        stream: request.body as ReadableStream<Uint8Array>,
        size,
        type: type === "application/x-www-form-urlencoded" ? "application/octet-stream" : type,
      },
      link.f,
      {
        as: link.as,
        caption: link.cap,
        format: link.fmt,
        buttons: link.b,
        replyTo: link.r,
        topic: link.t,
        silent: link.s,
        session: link.ss,
      },
    );
    const url = sentLink(ctx, chat, message);
    return plain(
      `Sent ${link.f} (${humanSize(size)}) to ${where(chat)} as message #${message.message_id}.${url ? ` ${url}` : ""}`,
      200,
    );
  } catch (error) {
    if (error instanceof TelegramError) {
      return plain(
        `Telegram refused the file: ${error.description}. Ask for a new upload link.`,
        502,
      );
    }
    if (error instanceof AccessError || error instanceof ToolError)
      return plain(error.message, 403);
    throw error;
  }
}

export async function attachment(ctx: ToolContext, chatId: number, messageId: number) {
  const chat = await ctx.access.resolve(chatId);
  const message = await ctx.store.getMessage(chat, messageId);
  if (!message || message.date < chat.visible_from) {
    throw new AccessError(
      `Message #${messageId} is not stored (older than retention, or never seen).`,
    );
  }
  if (!message.file_id) throw new AccessError(`Message #${messageId} has no attachment.`);
  return message;
}

export async function handleDownload(
  request: Request,
  limiter: RateLimit | undefined,
  contextFor: ToolContextFor,
  signingKey: CryptoKey,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return plain("GET only.", 405);
  if (!(await allow(limiter, clientIp(request)))) return tooManyRequests("Too many downloads.");

  const token = new URL(request.url).pathname.slice("/file/".length).split("/")[0];
  const link = await verify<FileBlob>(signingKey, "file", token);
  if (!link) return plain("This download link is invalid or expired. Ask for a new one.", 403);

  const ctx = await contextFor(link.u);
  if (!(await stillValid(ctx, link.u, link.v))) {
    return plain("This download link was revoked. Ask for a new one.", 403);
  }
  let message: StoredMessage;
  try {
    message = await attachment(ctx, link.c, link.m);
  } catch (error) {
    if (error instanceof AccessError) return plain(error.message, 403);
    throw error;
  }
  if (message.file_size && message.file_size > MAX_DOWNLOAD_BYTES) {
    return plain(
      `Telegram lets bots download files up to 20 MB; this one is ${humanSize(message.file_size)}.`,
      413,
    );
  }

  try {
    const { response } = await ctx.api.download(message.file_id!);
    const name = message.file_name ?? `${message.file_kind}`;
    const headers = new Headers({
      "content-type":
        message.file_mime ?? response.headers.get("content-type") ?? "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    const length = response.headers.get("content-length");
    if (length) headers.set("content-length", length);
    return new Response(request.method === "HEAD" ? null : response.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof TelegramError) {
      return plain(
        /file is too big/i.test(error.description)
          ? "Telegram lets bots download files up to 20 MB."
          : `Telegram refused the download: ${error.description}`,
        502,
      );
    }
    throw error;
  }
}

const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|xml|html?|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|log|env|conf|cfg|diff|patch|tex|srt|vtt)$/i;

export function isTextual(message: Pick<StoredMessage, "file_mime" | "file_name">): boolean {
  const mime = message.file_mime ?? "";
  if (mime.startsWith("text/")) return true;
  if (/json|xml|yaml|toml|csv|javascript|typescript|x-sh|sql/.test(mime)) return true;
  return TEXT_EXTENSIONS.test(message.file_name ?? "");
}

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function isInlineImage(message: Pick<StoredMessage, "file_mime" | "file_kind">): boolean {
  return message.file_kind === "photo" || IMAGE_MIMES.has(message.file_mime ?? "");
}

/** The file's bytes, when small enough to hand to the model directly. */
export async function inlineBytes(
  ctx: ToolContext,
  message: StoredMessage,
): Promise<Uint8Array | null> {
  const limit = isInlineImage(message)
    ? INLINE_IMAGE_BYTES
    : isTextual(message)
      ? INLINE_TEXT_BYTES
      : 0;
  if (!limit || (message.file_size ?? limit + 1) > limit) return null;
  const { response } = await ctx.api.download(message.file_id!);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.byteLength <= limit ? bytes : null;
}

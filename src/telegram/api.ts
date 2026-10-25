/**
 * Thin Bot API client: one `call` for every JSON method, one `upload` for the
 * multipart ones, and file download. No method list to keep in sync — Telegram
 * adds methods faster than any wrapper would.
 */

import type { TgFile, User } from "./types";

const API = "https://api.telegram.org";

/** Bot API caps, from core.telegram.org/bots/api#sending-files. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${method} failed (${code}): ${description}`);
  }

  /** The user blocked the bot, or never pressed Start, or the bot was removed. */
  get cannotReach(): boolean {
    return (
      this.code === 403 ||
      /chat not found|bot was blocked|user is deactivated|bot was kicked/i.test(this.description)
    );
  }
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
  ) {}

  async call<T>(method: string, params: object = {}): Promise<T> {
    const response = await this.fetcher(`${API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    return this.unwrap<T>(method, response);
  }

  /** A multipart call carrying one file under `field`. */
  async upload<T>(
    method: string,
    params: Record<string, unknown>,
    field: string,
    file: Blob,
    filename: string,
  ): Promise<T> {
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      form.append(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    form.append(field, file, filename);

    const response = await this.fetcher(`${API}/bot${this.token}/${method}`, {
      method: "POST",
      body: form,
    });
    return this.unwrap<T>(method, response);
  }

  /**
   * A multipart call whose file part is streamed from `body` without ever
   * holding it in memory — a 50 MB upload would not fit next to its own copy
   * in a 128 MB isolate. The total length is known up front (the file's size
   * comes from the uploader's Content-Length), so the request goes out with a
   * real Content-Length through Workers' FixedLengthStream.
   */
  async uploadStream<T>(
    method: string,
    params: Record<string, unknown>,
    field: string,
    file: { body: ReadableStream<Uint8Array>; size: number; name: string; type: string },
  ): Promise<T> {
    const boundary = `----telegram-mcp-${crypto.randomUUID()}`;
    const encoder = new TextEncoder();
    const quote = (value: string) => value.replace(/["\r\n\\]/g, "_");

    let head = "";
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      const text = typeof value === "string" ? value : JSON.stringify(value);
      head += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${text}\r\n`;
    }
    head +=
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${quote(file.name)}"\r\n` +
      `Content-Type: ${quote(file.type)}\r\n\r\n`;
    const preamble = encoder.encode(head);
    const closing = encoder.encode(`\r\n--${boundary}--\r\n`);
    const total = preamble.byteLength + file.size + closing.byteLength;

    const { readable, writable } = new FixedLengthStream(total);
    const pump = (async () => {
      const writer = writable.getWriter();
      try {
        await writer.write(preamble);
        const reader = file.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
        await writer.write(closing);
        await writer.close();
      } catch (error) {
        await writer.abort(error).catch(() => undefined);
        throw error;
      }
    })();

    const [response] = await Promise.all([
      this.fetcher(`${API}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body: readable,
        // Required by Node-style fetch implementations for a streamed body; Workers ignore it.
        duplex: "half",
      }),
      pump,
    ]);
    return this.unwrap<T>(method, response);
  }

  getMe(): Promise<User> {
    return this.call<User>("getMe");
  }

  /** The file's bytes as a stream, plus what Telegram says about it. */
  async download(fileId: string): Promise<{ file: TgFile; response: Response }> {
    const file = await this.call<TgFile>("getFile", { file_id: fileId });
    if (!file.file_path) {
      throw new TelegramError("getFile", 400, "Telegram gave no path for this file.");
    }
    const response = await this.fetcher(`${API}/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) {
      throw new TelegramError("download", response.status, "Telegram refused the file download.");
    }
    return { file, response };
  }

  private async unwrap<T>(method: string, response: Response): Promise<T> {
    let body: ApiResponse<T>;
    try {
      body = await response.json<ApiResponse<T>>();
    } catch {
      throw new TelegramError(
        method,
        response.status,
        "Telegram answered with something not JSON.",
      );
    }
    if (!body.ok || body.result === undefined) {
      throw new TelegramError(
        method,
        body.error_code ?? response.status,
        body.description ?? "no description",
        body.parameters?.retry_after,
      );
    }
    return body.result;
  }
}

/** Bot identity, fetched once per isolate. */
let me: Promise<User> | undefined;

export function botIdentity(api: TelegramApi): Promise<User> {
  if (!me) {
    me = api.getMe();
    me.catch(() => (me = undefined));
  }
  return me;
}

/** For tests. */
export function resetBotIdentity(): void {
  me = undefined;
}

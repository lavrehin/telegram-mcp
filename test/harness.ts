/**
 * End-to-end harness: the real Worker, a real SQLite behind the D1 API, and a
 * fake Telegram that answers Bot API calls and records them. Tests drive it
 * the way production does — webhook POSTs in, OAuth and MCP over HTTP.
 */

import { resetBotIdentity } from "../src/telegram/api";
import { resetWebhookCache } from "../src/bot/setup";
import { resetTestStarts } from "../src/bot/routine";
import {
  bytesToHex,
  hmac,
  hmacKey,
  sha256,
  sha256Base64Url,
  bytesToBase64Url,
} from "../src/crypto";
import worker from "../src/index";
import type { Env } from "../src/env";
import { SqliteD1 } from "./sqlite-d1";

const BOT_TOKEN = "123456:TEST-token_abcdefghijklmnopqrstuvwxyz";
const BOT_ID = 123456;
const BOT_USERNAME = "test_mcp_bot";
export const ORIGIN = "https://tg.example.workers.dev";
const TELEGRAM_IP = "149.154.167.50";

interface ApiCall {
  method: string;
  params: Record<string, unknown>;
  file?: { field: string; name: string; size: number };
}

type Handler = (params: Record<string, unknown>) => unknown;

class FakeTelegram {
  calls: ApiCall[] = [];
  handlers = new Map<string, Handler>();
  members = new Map<string, string>(); // `${chat}:${user}` → status
  chats = new Map<number, Record<string, unknown>>();
  files = new Map<string, { path: string; bytes: Uint8Array }>();
  privacyOn = false;
  /** Business connection id → the account it acts for. */
  businessOwners = new Map<string, { id: number; first_name: string }>();
  private nextId = 1000;

  constructor() {
    this.handlers.set("getMe", () => ({
      id: BOT_ID,
      is_bot: true,
      first_name: "Test",
      username: BOT_USERNAME,
      can_read_all_group_messages: !this.privacyOn,
    }));
    for (const method of [
      "setWebhook",
      "setMyCommands",
      "deleteMyCommands",
      "sendChatAction",
      "leaveChat",
      "pinChatMessage",
      "unpinChatMessage",
      "setMessageReaction",
      "deleteMessage",
      "answerCallbackQuery",
      "readBusinessMessage",
      "deleteBusinessMessages",
    ]) {
      this.handlers.set(method, () => true);
    }
    this.handlers.set("getWebhookInfo", () => ({
      url: `${ORIGIN}/telegram`,
      pending_update_count: 0,
    }));
    const bot = { id: BOT_ID, is_bot: true, first_name: "Test", username: BOT_USERNAME };
    const send = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      // On behalf of a business account, the message is that account's, marked as sent by the bot.
      const connection = params.business_connection_id as string | undefined;
      const owner = connection ? this.businessOwners.get(connection) : undefined;
      if (connection && !owner) throw new TgError(400, "Bad Request: BUSINESS_CONNECTION_INVALID");
      return {
        message_id: this.nextId++,
        date: Math.floor(Date.now() / 1000),
        chat: {
          id: Number(params.chat_id),
          type: Number(params.chat_id) > 0 ? "private" : "supergroup",
        },
        from: owner ? { is_bot: false, ...owner } : bot,
        ...(owner ? { business_connection_id: connection, sender_business_bot: bot } : {}),
        ...(params.message_thread_id
          ? { message_thread_id: Number(params.message_thread_id), is_topic_message: true }
          : {}),
        ...extra,
      };
    };
    this.handlers.set("sendMessage", (params) => send(params, { text: params.text }));
    this.handlers.set("sendDocument", (params) =>
      send(params, {
        caption: params.caption,
        document: {
          file_id: `doc-${this.nextId}`,
          file_unique_id: "u",
          file_name: (params as { _name?: string })._name,
          file_size: (params as { _size?: number })._size,
        },
      }),
    );
    this.handlers.set("sendPhoto", (params) =>
      send(params, {
        photo: [{ file_id: `photo-${this.nextId}`, file_unique_id: "u", width: 10, height: 10 }],
      }),
    );
    this.handlers.set("sendPoll", (params) =>
      send(params, { poll: { question: params.question, options: [] } }),
    );
    this.handlers.set("copyMessage", () => ({ message_id: this.nextId++ }));
    this.handlers.set("editMessageText", () => true);
    this.handlers.set("editMessageReplyMarkup", () => true);
    this.handlers.set("getChatMember", (params) => {
      const status = this.members.get(`${String(params.chat_id)}:${String(params.user_id)}`);
      if (!status) throw new TgError(400, "Bad Request: user not found");
      return { status, user: { id: Number(params.user_id), is_bot: false, first_name: "X" } };
    });
    this.handlers.set("getChat", (params) => {
      const chat =
        this.chats.get(Number(params.chat_id)) ??
        [...this.chats.values()].find((c) => `@${String(c.username)}` === params.chat_id);
      if (!chat) throw new TgError(400, "Bad Request: chat not found");
      return chat;
    });
    this.handlers.set("getFile", (params) => {
      const file = this.files.get(String(params.file_id));
      if (!file) throw new TgError(400, "Bad Request: invalid file_id");
      return {
        file_id: params.file_id,
        file_unique_id: "u",
        file_path: file.path,
        file_size: file.bytes.byteLength,
      };
    });
  }

  called(method: string): ApiCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const fileMatch = /^\/file\/bot[^/]+\/(.+)$/.exec(url.pathname);
    if (fileMatch) {
      const file = [...this.files.values()].find((f) => f.path === fileMatch[1]);
      return file ? new Response(file.bytes) : new Response("not found", { status: 404 });
    }
    const method = url.pathname.split("/").pop()!;
    let params: Record<string, unknown> = {};
    let file: ApiCall["file"];
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("multipart/form-data")) {
      const form = await request.formData();
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") {
          try {
            params[key] = JSON.parse(value);
          } catch {
            params[key] = value;
          }
        } else {
          const blob = value;
          file = { field: key, name: blob.name, size: blob.size };
          params._name = blob.name;
          params._size = blob.size;
        }
      }
    } else if (type.includes("json")) {
      params = await request.json<Record<string, unknown>>();
    }
    this.calls.push({ method, params, file });
    const handler = this.handlers.get(method);
    if (!handler)
      return Response.json({ ok: false, error_code: 404, description: `Not Found: ${method}` });
    try {
      return Response.json({ ok: true, result: handler(params) });
    } catch (error) {
      if (error instanceof TgError)
        return Response.json({ ok: false, error_code: error.code, description: error.description });
      throw error;
    }
  }
}

export class TgError extends Error {
  constructor(
    readonly code: number,
    readonly description: string,
  ) {
    super(description);
  }
}

/**
 * Workers' FixedLengthStream, for Bun: a pass-through that, like the real one,
 * refuses a body whose length differs from the one declared.
 */
class FixedLengthStreamPolyfill extends TransformStream<Uint8Array, Uint8Array> {
  constructor(expected: number) {
    let seen = 0;
    super({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > expected) throw new Error("FixedLengthStream: body longer than declared");
        controller.enqueue(chunk);
      },
      flush() {
        if (seen !== expected)
          throw new Error(`FixedLengthStream: got ${seen} bytes, declared ${expected}`);
      },
    });
  }
}
(globalThis as Record<string, unknown>).FixedLengthStream ??= FixedLengthStreamPolyfill;

/**
 * What the consent page /authorize answers with hands on: the Telegram login
 * link, and the cookie the return from Telegram must carry.
 */
export async function consentLink(
  response: Response,
): Promise<{ telegram: URL; returnTo: string; cookie: string }> {
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const href = /id="continue" href="([^"]+)"/.exec(await response.text())![1];
  const telegram = new URL(href.replaceAll("&amp;", "&"));
  const back = new URL(telegram.searchParams.get("return_to")!);
  return { telegram, returnTo: `${back.pathname}${back.search}`, cookie };
}

export class Harness {
  db = new SqliteD1();
  telegram = new FakeTelegram();
  env: Env;
  waits: Promise<unknown>[] = [];
  /** Routine starts the Worker made, and how the fake API answers the next one. */
  fires: { url: string; headers: Headers; body: { text: string } }[] = [];
  fireAnswer: () => Response = () =>
    Response.json({
      claude_code_session_id: "cse_01TestSession0000000001",
      claude_code_session_url: "https://claude.ai/code/session_01TestSession0000000001",
    });
  private updateId = 1;
  private messageIds = new Map<number, number>();
  private realFetch = globalThis.fetch;

  constructor(vars: Partial<Env> = {}) {
    this.env = { BOT_TOKEN, DB: this.db.asD1(), RETENTION_DAYS: "14", ...vars };
    resetBotIdentity();
    resetWebhookCache();
    resetTestStarts();
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const host = new URL(request.url).hostname;
      if (host === "api.telegram.org") return this.telegram.handle(request);
      if (host === "api.anthropic.com") {
        return request.json().then((body) => {
          this.fires.push({
            url: request.url,
            headers: request.headers,
            body: body as { text: string },
          });
          return this.fireAnswer();
        });
      }
      throw new Error(`Unexpected fetch to ${request.url}`);
    }) as typeof fetch;
  }

  restore(): void {
    globalThis.fetch = this.realFetch;
  }

  async fetch(path: string, init: RequestInit & { ip?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", init.ip ?? "203.0.113.7");
    const request = new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" });
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => this.waits.push(promise),
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    const response = await worker.fetch(
      request as Request<unknown, IncomingRequestCfProperties>,
      this.env,
      ctx,
    );
    await Promise.allSettled(this.waits);
    return response;
  }

  /** The key the Worker signs its tokens with. */
  async signingKey(): Promise<CryptoKey> {
    return hmacKey(await hmac(await hmacKey(BOT_TOKEN), "telegram-mcp/sign"));
  }

  /** POST /token with a refresh grant. */
  async refresh(refreshToken: string) {
    const response = await this.fetch("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    return {
      status: response.status,
      body: await response.json<{ access_token?: string; refresh_token?: string }>(),
    };
  }

  async webhookSecret(): Promise<string> {
    const root = await hmacKey(BOT_TOKEN);
    return bytesToHex(await hmac(root, "telegram-mcp/webhook"));
  }

  async update(
    update: Record<string, unknown>,
    options: { ip?: string; secret?: string } = {},
  ): Promise<Response> {
    return this.fetch("/telegram", {
      method: "POST",
      ip: options.ip ?? TELEGRAM_IP,
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": options.secret ?? (await this.webhookSecret()),
      },
      body: JSON.stringify({ update_id: this.updateId++, ...update }),
    });
  }

  nextMessageId(chatId: number): number {
    const id = (this.messageIds.get(chatId) ?? 0) + 1;
    this.messageIds.set(chatId, id);
    return id;
  }

  /** Post a message as a user. Returns the message object sent. */
  async say(
    chat: { id: number; type?: string; title?: string; is_forum?: boolean; username?: string },
    from: { id: number; first_name?: string; username?: string; language_code?: string },
    text: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const message = {
      message_id: this.nextMessageId(chat.id),
      date: Math.floor(Date.now() / 1000),
      chat: { type: chat.id > 0 ? "private" : "supergroup", ...chat },
      from: { is_bot: false, first_name: from.first_name ?? `User${from.id}`, ...from },
      text,
      ...extra,
    };
    const response = await this.update({ message });
    (message as Record<string, unknown>)._reply = response.headers
      .get("content-type")
      ?.includes("json")
      ? await response.json()
      : null;
    return message;
  }

  private businessIds = new Map<number, number>();

  /** The user connects the bot to their account in Telegram's settings, or changes or ends that. */
  async businessConnect(
    owner: { id: number; first_name?: string; username?: string; language_code?: string },
    rights: Record<string, boolean> = {},
    enabled = true,
  ): Promise<{ method: string; text: string } | null> {
    const id = `bc-${owner.id}`;
    const user = { is_bot: false, first_name: owner.first_name ?? `User${owner.id}`, ...owner };
    this.telegram.businessOwners.set(id, { id: owner.id, first_name: user.first_name });
    const response = await this.update({
      business_connection: {
        id,
        user,
        user_chat_id: owner.id,
        date: Math.floor(Date.now() / 1000),
        rights,
        is_enabled: enabled,
      },
    });
    return response.headers.get("content-type")?.includes("json") ? response.json() : null;
  }

  /**
   * A message in the owner's personal chat with `peer`: from the peer, or with
   * `outgoing`, written by the owner. Ids count per owner account, as in Telegram.
   */
  async businessSay(
    owner: { id: number; first_name?: string },
    peer: { id: number; first_name?: string; username?: string },
    text: string,
    options: { outgoing?: boolean; date?: number; edit?: number } = {},
  ): Promise<Record<string, unknown>> {
    const messageId = options.edit ?? (this.businessIds.get(owner.id) ?? 0) + 1;
    if (!options.edit) this.businessIds.set(owner.id, messageId);
    const author = options.outgoing ? owner : peer;
    const message = {
      message_id: messageId,
      business_connection_id: `bc-${owner.id}`,
      date: options.date ?? Math.floor(Date.now() / 1000),
      ...(options.edit ? { edit_date: Math.floor(Date.now() / 1000) } : {}),
      chat: {
        id: peer.id,
        type: "private",
        first_name: peer.first_name ?? `User${peer.id}`,
        ...(peer.username ? { username: peer.username } : {}),
      },
      from: { is_bot: false, first_name: author.first_name ?? `User${author.id}`, ...author },
      text,
    };
    await this.update(
      options.edit ? { edited_business_message: message } : { business_message: message },
    );
    return message;
  }

  /** Tables exist only after the Worker's first request; tests poking SQL first need them now. */
  async ensureSchema(): Promise<void> {
    await this.fetch("/health");
    const { ensureSchema } = await import("../src/schema");
    await ensureSchema(this.env.DB);
  }

  /** As if the user had signed an assistant in (the precondition for linking groups). */
  markConnected(...users: { id: number; first_name?: string }[]): void {
    for (const user of users) {
      this.db.raw
        .query(
          `INSERT INTO users (user_id, first_name, created_at, connected_at) VALUES (?, ?, 1, 1)
           ON CONFLICT (user_id) DO UPDATE SET connected_at = COALESCE(connected_at, 1)`,
        )
        .run(user.id, user.first_name ?? null);
    }
  }

  async addBot(
    chat: { id: number; title: string; type?: string; is_forum?: boolean; username?: string },
    by: { id: number; first_name?: string },
    status = "member",
    options: { connected?: boolean } = {},
  ) {
    if (options.connected !== false) {
      await this.ensureSchema();
      this.markConnected(by);
    }
    this.telegram.chats.set(chat.id, { type: "supergroup", ...chat });
    return this.update({
      my_chat_member: {
        chat: { type: "supergroup", ...chat },
        from: { is_bot: false, first_name: by.first_name ?? `User${by.id}`, ...by },
        date: Math.floor(Date.now() / 1000),
        old_chat_member: { status: "left", user: { id: BOT_ID, is_bot: true, first_name: "Test" } },
        new_chat_member: { status, user: { id: BOT_ID, is_bot: true, first_name: "Test" } },
      },
    });
  }

  /** A Telegram Login payload signed the way Telegram signs it. */
  async loginPayload(
    user: { id: number; first_name?: string; username?: string },
    authDate = Math.floor(Date.now() / 1000),
  ) {
    const fields: Record<string, string | number> = {
      id: user.id,
      first_name: user.first_name ?? "Test",
      auth_date: authDate,
    };
    if (user.username) fields.username = user.username;
    const check = Object.keys(fields)
      .sort()
      .map((key) => `${key}=${fields[key]}`)
      .join("\n");
    const key = await hmacKey(await sha256(BOT_TOKEN));
    return { ...fields, hash: bytesToHex(await hmac(key, check)) };
  }

  /** The whole OAuth dance; returns the token response. */
  async connect(
    user: { id: number; first_name?: string; username?: string },
    client: { redirect?: string; name?: string } = {},
  ) {
    const redirect = client.redirect ?? "https://claude.ai/api/mcp/auth_callback";
    const register = await this.fetch("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirect], client_name: client.name ?? "test" }),
    });
    const { client_id } = await register.json<{ client_id: string }>();

    const verifier = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = await sha256Base64Url(verifier);
    const authorize = await this.fetch(
      `/authorize?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirect, state: "xyz", code_challenge: challenge, code_challenge_method: "S256" }).toString()}`,
    );
    const consent = await consentLink(authorize);

    const finish = await this.fetch(consent.returnTo, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: consent.cookie },
      body: JSON.stringify(await this.loginPayload(user)),
    });
    const body = await finish.json<{ redirect?: string; error?: string }>();
    if (!body.redirect) throw new Error(`login failed: ${body.error}`);
    const code = new URL(body.redirect).searchParams.get("code")!;

    const token = await this.fetch("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
        client_id,
      }),
    });
    return token.json<{ access_token: string; refresh_token: string }>();
  }

  private rpcId = 1;

  async mcp(
    token: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<{ status: number; body: unknown }> {
    const response = await this.fetch("/", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.rpcId++, method, params }),
    });
    const raw = await response.text();
    const data = raw.includes("data:")
      ? raw
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5))
          .join("")
      : raw;
    return { status: response.status, body: data ? JSON.parse(data) : null };
  }

  /** Call a tool; returns its text and whether it was an error. */
  async tool(token: string, name: string, args: Record<string, unknown> = {}) {
    const { status, body } = await this.mcp(token, "tools/call", { name, arguments: args });
    const result = (
      body as {
        result?: { content: { type: string; text?: string }[]; isError?: boolean };
        error?: unknown;
      }
    ).result;
    if (!result) throw new Error(`tools/call ${name} failed (${status}): ${JSON.stringify(body)}`);
    return {
      text: result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
      content: result.content,
      isError: result.isError === true,
    };
  }
}

/**
 * Every SQL statement the connector runs.
 *
 * Kept in one place so the cost of each path is visible: D1 bills rows read
 * and written per account, and the free plan stops all queries for the rest
 * of the day once either cap is hit. See src/schema.ts for why `messages`
 * carries no secondary index.
 */

import { nowSeconds } from "./crypto";
import { redactSecrets } from "./secrets";

export interface StoredMessage {
  /** 0 for the bot's own chats; the user's id for their personal chats (see schema). */
  account_id: number;
  chat_id: number;
  message_id: number;
  date: number;
  edited_at: number | null;
  thread_id: number | null;
  from_id: number | null;
  from_name: string | null;
  from_username: string | null;
  forwarded_from: string | null;
  text: string;
  reply_to_id: number | null;
  /** Highlighted part of the replied-to message, or a note about a cross-chat reply. */
  quote: string | null;
  mentions_bot: boolean;
  outgoing: boolean;
  file_kind: string | null;
  file_id: string | null;
  file_name: string | null;
  file_mime: string | null;
  file_size: number | null;
  /** JSON of `StoredButton[][]`, for messages the MCP sent with buttons. */
  buttons: string | null;
  mark_choice: boolean;
  /** For the bot's own messages: whose assistant sent it. Only they may edit or delete it. */
  sent_by: number | null;
  /** The inline bot the text came from ("via @gif"): the sender picked it, did not write it. */
  via_bot: string | null;
  /** Posted as the chat (an anonymous admin, a linked channel): no person is known. */
  as_chat: boolean;
  /** For the bot's own messages: the Claude Code cloud session that sent it (session_…). */
  session_id: string | null;
  /** Read only (markAwaited sets it): until when that session waits for an answer. */
  awaited_until?: number | null;
  /** Telegram's media_group_id: the photos and files sent together, shown as one message. */
  album?: string | null;
}

export interface StoredButton {
  text: string;
  data?: string;
  url?: string;
}

interface MessageRow extends Omit<
  StoredMessage,
  "mentions_bot" | "outgoing" | "mark_choice" | "as_chat"
> {
  mentions_bot: number;
  outgoing: number;
  mark_choice: number;
  as_chat: number;
}

export interface Routine {
  user_id: number;
  trigger_id: string;
  token_enc: string;
  updated_at: number;
  /** The last test start: its session, and when. */
  test_session: string | null;
  test_at: number | null;
}

export interface ClaudeChat {
  chat_id: number;
  user_id: number;
  others: number;
  /** Other members' starts allowed per hour. */
  others_limit: number;
  since: number;
}

/** A start being claimed: whose routine, and what the log shows of it. */
export interface FireEntry {
  chatId: number;
  messageId: number;
  userId: number;
  byOther: boolean;
  fromName: string | null;
  /** The first words of the message, keys removed. */
  excerpt: string;
  /** An album starts once, whichever of its items comes first. */
  album: string | null;
}

export interface RelayRow {
  user_id: number;
  token_hash: string;
  created_at: number;
  last_seen: number | null;
  login_failed_at: number | null;
  offline_noticed_at: number | null;
}

/** Who stands behind a message to a session, by the bot's records. */
export type RelayOrigin = "user" | "other" | "unknown";

export interface RelayJob {
  id: string;
  user_id: number;
  target_session: string;
  body: string;
  origin: RelayOrigin;
  from_session: string | null;
  /** For a Telegram reply passed on: where it was, so a failure can start a session instead. */
  chat_id: number | null;
  message_id: number | null;
  thread_id: number | null;
  status: "queued" | "taken" | "done" | "failed";
  error: string | null;
  /** reply: a Telegram reply to the session's message; day: a private-chat message for the day's session. */
  kind: "reply" | "day" | "ask";
  /** 1 when the sender waits for answer_session; a notice expects none. */
  wants_answer: number;
  answer: string | null;
  answered_at: number | null;
  created_at: number;
  taken_at: number | null;
}

/** A session the bot knows of: started by a tag, wrote through the bot, or was written to. */
export interface KnownSession {
  session_id: string;
  started?: {
    chat_id: number;
    at: number;
    from_name: string | null;
    excerpt: string | null;
    by_other: boolean;
  };
  wrote?: { chat_id: number; at: number; text: string };
  asked_at?: number;
}

export interface FireRow {
  message_id: number;
  /**
   * relayed: passed on to an existing session instead of a new one. joined:
   * came right after a start in the private chat, which reads it along.
   */
  status: "pending" | "started" | "relayed" | "joined" | "failed";
  session_id: string | null;
  at: number;
  from_name: string | null;
  excerpt: string | null;
}

export interface MemoryDoc {
  user_id: number;
  chat_id: number;
  content: string;
  updated_at: number;
  /** The assistant that last wrote it, by its sign-in name. */
  updated_by: string | null;
}

export interface MemoryChange {
  id: number;
  user_id: number;
  chat_id: number;
  /** Null when the document did not exist before the change. */
  content_before: string | null;
  changed_at: number;
  changed_by: string | null;
}

export interface MemoryNotice {
  user_id: number;
  chat_id: number;
  client: string;
  message_id: number;
  first_history_id: number;
  sent_at: number;
}

export interface RefreshSessionRow {
  id: string;
  user_id: number;
  generation: number;
  rotated_at: number;
  expires_at: number;
  revoked: number;
  /** Who the sign-in went to: "Claude", "ChatGPT", an app on this computer. Null before it was kept. */
  client_name: string | null;
  created_at: number | null;
}

/** What checking a token needs, in one read: the user, and the sign-in it belongs to. */
export interface TokenState {
  token_version: number;
  connected_at: number | null;
  username: string | null;
  first_name: string | null;
  /** Null when the token names no sign-in, or that sign-in has no row. */
  session_revoked: number | null;
  /** Who that sign-in went to, when known. */
  client_name: string | null;
}

export interface UserRow {
  user_id: number;
  username: string | null;
  first_name: string | null;
  language: string | null;
  token_version: number;
  created_at: number;
  connected_at: number | null;
}

export interface ChatRow {
  chat_id: number;
  type: string;
  title: string | null;
  username: string | null;
  is_forum: number;
  bot_is_admin: number;
  visible_history: number | null;
  updated_at: number;
}

export interface GrantRow {
  user_id: number;
  chat_id: number;
  source: "added_bot" | "connect";
  visible_from: number;
  granted_at: number;
  verified_at: number;
}

export type GrantWithChat = GrantRow & Pick<ChatRow, "type" | "title" | "username" | "is_forum">;

export interface PressRow {
  chat_id: number;
  message_id: number;
  callback_id: string;
  user_id: number;
  user_name: string | null;
  label: string;
  data: string;
  date: number;
}

export interface ReactionRow {
  chat_id: number;
  message_id: number;
  user_id: number;
  user_name: string | null;
  emoji: string;
  date: number;
}

export interface TopicRow {
  chat_id: number;
  thread_id: number;
  name: string;
}

/** A chat as seen from one account: the bot's (0), or a user's own via Telegram Business. */
export interface ChatRef {
  account_id: number;
  chat_id: number;
}

/** The bot's own account, which holds its private chats and every group. */
export const BOT_ACCOUNT = 0;

/** A Map key for a chat. */
export function refKey(ref: ChatRef): string {
  return `${ref.account_id}:${ref.chat_id}`;
}

/** One chat a search may look in, from the moment its reader is allowed to see. */
export interface Scope extends ChatRef {
  visible_from: number;
}

export interface BusinessRow {
  user_id: number;
  connection_id: string;
  /** JSON of BusinessBotRights. */
  rights: string;
  enabled: number;
  connected_at: number;
  updated_at: number;
}

export interface PersonalChatRow {
  account_id: number;
  chat_id: number;
  title: string | null;
  username: string | null;
}

export interface SearchQuery {
  scopes: Scope[];
  keywords: string[];
  from?: string;
  mentionsOnly?: boolean;
  hasFile?: boolean;
  fileKind?: string;
  /** Forum topic (message_thread_id). */
  threadId?: number;
  direction?: "incoming" | "outgoing" | "any";
  since?: number;
  until?: number;
  limit: number;
}

/** How far apart an album's message ids can be: ten items, and others' messages between them. */
const ALBUM_SPAN = 30;

/** D1 refuses more than 100 bound parameters in one statement; a scope takes four. */
export const MAX_SCOPES = 20;

function toMessage(row: MessageRow): StoredMessage {
  return {
    ...row,
    mentions_bot: row.mentions_bot === 1,
    outgoing: row.outgoing === 1,
    mark_choice: row.mark_choice === 1,
    as_chat: row.as_chat === 1,
  };
}

/** Lower-cased in JS: SQLite's lower() only folds ASCII, which breaks Cyrillic search. */
function normalize(text: string): string {
  return text.toLocaleLowerCase("en-US").replaceAll("ё", "е");
}

function likePattern(keyword: string): string {
  return `%${normalize(keyword).replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const MESSAGE_COLUMNS = [
  "account_id",
  "chat_id",
  "message_id",
  "date",
  "edited_at",
  "thread_id",
  "from_id",
  "from_name",
  "from_username",
  "forwarded_from",
  "text",
  "text_lc",
  "reply_to_id",
  "quote",
  "mentions_bot",
  "outgoing",
  "file_kind",
  "file_id",
  "file_name",
  "file_mime",
  "file_size",
  "buttons",
  "mark_choice",
  "sent_by",
  "via_bot",
  "as_chat",
  "session_id",
  "album",
] as const;

function messageValues(message: StoredMessage): unknown[] {
  const text = redactSecrets(message.text);
  return [
    message.account_id,
    message.chat_id,
    message.message_id,
    message.date,
    message.edited_at,
    message.thread_id,
    message.from_id,
    message.from_name,
    message.from_username,
    message.forwarded_from,
    text,
    normalize(text),
    message.reply_to_id,
    redactSecrets(message.quote),
    message.mentions_bot ? 1 : 0,
    message.outgoing ? 1 : 0,
    message.file_kind,
    message.file_id,
    message.file_name,
    message.file_mime,
    message.file_size,
    message.buttons,
    message.mark_choice ? 1 : 0,
    message.sent_by,
    message.via_bot,
    message.as_chat ? 1 : 0,
    message.session_id,
    message.album ?? null,
  ];
}

/**
 * When a message may be written: always (the bot's own, sent through the
 * MCP), while a private chat's owner is registered, while a group has at
 * least one grant, or while a user's business connection is on.
 */
export type Guard = "always" | "dm" | "group" | "personal";

function guardSql(guard: Guard, message: ChatRef): [string, ...unknown[]] {
  switch (guard) {
    case "always":
      return ["1"];
    case "dm":
      return ["EXISTS (SELECT 1 FROM users WHERE user_id = ?)", message.chat_id];
    case "group":
      return ["EXISTS (SELECT 1 FROM grants WHERE chat_id = ?)", message.chat_id];
    case "personal":
      return [personalOn("?"), message.account_id];
  }
}

/**
 * A user's personal chats are stored while their business connection is on
 * and they have signed an assistant in; before that, nobody could read them.
 */
function personalOn(userParam: string): string {
  return `EXISTS (
    SELECT 1 FROM business_connections b JOIN users u ON u.user_id = b.user_id
    WHERE b.user_id = ${userParam} AND b.enabled = 1 AND u.connected_at IS NOT NULL
  )`;
}

/** Tables of a group's own, keyed by chat id alone. */
const GROUP_TABLES = [
  "grants",
  "button_presses",
  "reactions",
  "topics",
  "chats",
  "claude_chats",
  "fires",
];
/** Tables keyed by account too; a group's rows sit under the bot's account. */
const ACCOUNT_TABLES = ["messages", "day_marks"];
const HISTORY_TABLES = ["button_presses", "reactions", "topics", "chats"];
/** Tables keyed by user and chat: what one user keeps about one chat. */
const USER_CHAT_TABLES = ["memory_docs", "memory_history", "memory_notices"];
/** How many earlier versions of a memory document are kept for undo. */
const MEMORY_VERSIONS = 20;

const DAY = 86_400;

export class Store {
  constructor(readonly db: D1Database) {}

  // --- meta ----------------------------------------------------------------

  async getMeta(key: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE value <> excluded.value",
      )
      .bind(key, value)
      .run();
  }

  // --- users ---------------------------------------------------------------

  async upsertUser(user: {
    user_id: number;
    username?: string | null;
    first_name?: string | null;
    language?: string | null;
  }): Promise<void> {
    // The WHERE keeps an unchanged profile from costing a row write.
    await this.db
      .prepare(
        `INSERT INTO users (user_id, username, first_name, language, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (user_id) DO UPDATE SET
           username = excluded.username,
           first_name = COALESCE(excluded.first_name, first_name),
           language = COALESCE(excluded.language, language)
         WHERE username IS NOT excluded.username
            OR (excluded.first_name IS NOT NULL AND first_name IS NOT excluded.first_name)
            OR (excluded.language IS NOT NULL AND language IS NOT excluded.language)`,
      )
      .bind(
        user.user_id,
        user.username ?? null,
        user.first_name ?? null,
        user.language ?? null,
        nowSeconds(),
      )
      .run();
  }

  getUser(userId: number): Promise<UserRow | null> {
    return this.db.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first<UserRow>();
  }

  /** Record that the user has signed an assistant in; written once. */
  async markConnected(userId: number): Promise<void> {
    await this.db
      .prepare("UPDATE users SET connected_at = ? WHERE user_id = ? AND connected_at IS NULL")
      .bind(nowSeconds(), userId)
      .run();
  }

  /** Every token of the user stops working, and their sign-ins leave the list. */
  async bumpTokenVersion(userId: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("UPDATE users SET token_version = token_version + 1 WHERE user_id = ?")
        .bind(userId),
      this.db
        .prepare("UPDATE refresh_sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0")
        .bind(userId),
    ]);
  }

  // --- chats ---------------------------------------------------------------

  async upsertChat(chat: {
    chat_id: number;
    type: string;
    title?: string | null;
    username?: string | null;
    is_forum?: boolean;
    bot_is_admin?: boolean;
    visible_history?: boolean | null;
  }): Promise<void> {
    const flag = (value: boolean | null | undefined) =>
      value === undefined || value === null ? null : value ? 1 : 0;
    await this.db
      .prepare(
        `INSERT INTO chats (chat_id, type, title, username, is_forum, bot_is_admin, visible_history, updated_at)
         VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 0), COALESCE(?6, 0), ?7, ?8)
         ON CONFLICT (chat_id) DO UPDATE SET
           type = excluded.type,
           title = COALESCE(excluded.title, title),
           username = excluded.username,
           is_forum = COALESCE(?5, is_forum),
           bot_is_admin = COALESCE(?6, bot_is_admin),
           visible_history = COALESCE(?7, visible_history),
           updated_at = excluded.updated_at`,
      )
      .bind(
        chat.chat_id,
        chat.type,
        chat.title ?? null,
        chat.username ?? null,
        flag(chat.is_forum),
        flag(chat.bot_is_admin),
        flag(chat.visible_history),
        nowSeconds(),
      )
      .run();
  }

  /** A rename seen in the chat; no row is created for a chat we do not track. */
  async renameChat(chatId: number, title: string): Promise<void> {
    await this.db
      .prepare("UPDATE chats SET title = ?, updated_at = ? WHERE chat_id = ? AND title IS NOT ?")
      .bind(title, nowSeconds(), chatId, title)
      .run();
  }

  getChat(chatId: number): Promise<ChatRow | null> {
    return this.db.prepare("SELECT * FROM chats WHERE chat_id = ?").bind(chatId).first<ChatRow>();
  }

  /** Forget a group entirely: the bot left, or nobody has access any more. */
  async deleteChat(chatId: number): Promise<void> {
    await this.db.batch([
      ...USER_CHAT_TABLES.map((table) =>
        this.db.prepare(`DELETE FROM ${table} WHERE chat_id = ?`).bind(chatId),
      ),
      ...GROUP_TABLES.map((table) =>
        this.db.prepare(`DELETE FROM ${table} WHERE chat_id = ?`).bind(chatId),
      ),
      ...ACCOUNT_TABLES.map((table) =>
        this.db
          .prepare(`DELETE FROM ${table} WHERE account_id = ? AND chat_id = ?`)
          .bind(BOT_ACCOUNT, chatId),
      ),
    ]);
  }

  /** A group became a supergroup and got a new id; carry everything over. */
  async migrateChat(from: number, to: number): Promise<void> {
    await this.db.batch([
      ...[
        "grants",
        "button_presses",
        "reactions",
        "topics",
        "claude_chats",
        ...USER_CHAT_TABLES,
      ].map((table) =>
        this.db
          .prepare(`UPDATE OR IGNORE ${table} SET chat_id = ?2 WHERE chat_id = ?1`)
          .bind(from, to),
      ),
      ...ACCOUNT_TABLES.map((table) =>
        this.db
          .prepare(
            `UPDATE OR IGNORE ${table} SET chat_id = ?2 WHERE account_id = ?3 AND chat_id = ?1`,
          )
          .bind(from, to, BOT_ACCOUNT),
      ),
      this.db
        .prepare(
          `INSERT INTO chats (chat_id, type, title, username, is_forum, bot_is_admin, visible_history, updated_at)
           SELECT ?2, 'supergroup', title, username, is_forum, bot_is_admin, visible_history, updated_at
           FROM chats WHERE chat_id = ?1
           ON CONFLICT (chat_id) DO NOTHING`,
        )
        .bind(from, to),
      ...[...GROUP_TABLES, ...USER_CHAT_TABLES].map((table) =>
        this.db.prepare(`DELETE FROM ${table} WHERE chat_id = ?`).bind(from),
      ),
      ...ACCOUNT_TABLES.map((table) =>
        this.db
          .prepare(`DELETE FROM ${table} WHERE account_id = ? AND chat_id = ?`)
          .bind(BOT_ACCOUNT, from),
      ),
    ]);
  }

  // --- grants --------------------------------------------------------------

  /**
   * Give a user access to a group. An existing grant keeps the wider of the
   * two history windows, so reconnecting never narrows what someone sees.
   */
  async upsertGrant(
    userId: number,
    chatId: number,
    source: GrantRow["source"],
    visibleFrom: number,
  ): Promise<GrantRow> {
    const now = nowSeconds();
    const row = await this.db
      .prepare(
        `INSERT INTO grants (user_id, chat_id, source, visible_from, granted_at, verified_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT (user_id, chat_id) DO UPDATE SET
           visible_from = MIN(visible_from, excluded.visible_from),
           verified_at = excluded.verified_at
         RETURNING *`,
      )
      .bind(userId, chatId, source, visibleFrom, now)
      .first<GrantRow>();
    return row!;
  }

  getGrant(userId: number, chatId: number): Promise<GrantRow | null> {
    return this.db
      .prepare("SELECT * FROM grants WHERE user_id = ? AND chat_id = ?")
      .bind(userId, chatId)
      .first<GrantRow>();
  }

  async listGrants(userId: number): Promise<GrantWithChat[]> {
    const { results } = await this.db
      .prepare(
        `SELECT g.*, c.type, c.title, c.username, c.is_forum
         FROM grants g JOIN chats c ON c.chat_id = g.chat_id
         WHERE g.user_id = ?
         ORDER BY g.granted_at`,
      )
      .bind(userId)
      .all<GrantWithChat>();
    return results;
  }

  /**
   * Remove a grant, and with the last one the chat's whole history — in one
   * transaction, and only if no grant is left at commit. A /connect racing
   * with a revoke therefore either lands first and keeps the history, or
   * lands after and starts afresh; it never loses its own grant.
   * Returns whether the history went.
   */
  async revokeGrant(userId: number, chatId: number): Promise<boolean> {
    const results = await this.db.batch([
      // What the user kept about the group goes with their access to it.
      ...USER_CHAT_TABLES.map((table) =>
        this.db
          .prepare(`DELETE FROM ${table} WHERE user_id = ? AND chat_id = ?`)
          .bind(userId, chatId),
      ),
      this.db
        .prepare("DELETE FROM claude_chats WHERE user_id = ? AND chat_id = ?")
        .bind(userId, chatId),
      this.db.prepare("DELETE FROM grants WHERE user_id = ? AND chat_id = ?").bind(userId, chatId),
      ...this.purgeOrphanStatements(chatId),
    ]);
    return (results.at(-1)?.meta.changes ?? 0) > 0;
  }

  private purgeOrphanStatements(chatId: number): D1PreparedStatement[] {
    return [
      ...ACCOUNT_TABLES.map((table) =>
        this.db
          .prepare(
            `DELETE FROM ${table} WHERE account_id = ?2 AND chat_id = ?1
             AND NOT EXISTS (SELECT 1 FROM grants WHERE chat_id = ?1)`,
          )
          .bind(chatId, BOT_ACCOUNT),
      ),
      // `chats` goes last: revokeGrant reads the last statement's changes.
      ...HISTORY_TABLES.map((table) =>
        this.db
          .prepare(
            `DELETE FROM ${table} WHERE chat_id = ?1
             AND NOT EXISTS (SELECT 1 FROM grants WHERE chat_id = ?1)`,
          )
          .bind(chatId),
      ),
    ];
  }

  async touchGrant(userId: number, chatId: number): Promise<void> {
    await this.db
      .prepare("UPDATE grants SET verified_at = ? WHERE user_id = ? AND chat_id = ?")
      .bind(nowSeconds(), userId, chatId)
      .run();
  }

  // --- messages ------------------------------------------------------------

  /**
   * Store a message — but only while its chat is tracked, decided in the same
   * statement. Telegram delivers updates in parallel, so a separate "is this
   * chat tracked?" read could be stale by the time of the write (a revoke in
   * between would leave orphaned history behind). Inside one statement it
   * cannot be.
   *
   * Idempotent: Telegram retries a webhook it thinks failed. An edit that
   * overtook its original has already inserted the row; the original then
   * changes nothing.
   */
  async insertMessage(message: StoredMessage, guard: Guard): Promise<boolean> {
    const [condition, ...guardValues] = guardSql(guard, message);
    const [inserted] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO messages (${MESSAGE_COLUMNS.join(", ")})
           SELECT ${MESSAGE_COLUMNS.map(() => "?").join(", ")} WHERE ${condition}
           ON CONFLICT (account_id, chat_id, message_id) DO NOTHING`,
        )
        .bind(...messageValues(message), ...guardValues),
      this.markDayStatement(message, condition, guardValues),
    ]);
    return (inserted.meta.changes ?? 0) > 0;
  }

  /** Costs a write only for a chat's first message of a day (or an earlier one). */
  private markDayStatement(
    message: Pick<StoredMessage, "account_id" | "chat_id" | "message_id" | "date">,
    condition: string,
    guardValues: unknown[],
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO day_marks (account_id, chat_id, day, first_id)
         SELECT ?, ?, ?, ? WHERE ${condition}
         ON CONFLICT (account_id, chat_id, day) DO UPDATE SET first_id = excluded.first_id
         WHERE excluded.first_id < first_id`,
      )
      .bind(
        message.account_id,
        message.chat_id,
        Math.floor(message.date / DAY),
        message.message_id,
        ...guardValues,
      );
  }

  /**
   * The lowest message id that can be dated at or after `since` in each chat.
   * Ids grow within a chat, so a scan can start there. Chats with nothing
   * since then get +Infinity (MAX_SAFE_INTEGER): nothing to scan.
   */
  async idFloors(chats: ChatRef[], since: number[]): Promise<number[]> {
    if (!chats.length) return [];
    const results = await this.db.batch<{ first_id: number }>(
      chats.map((chat, index) =>
        this.db
          .prepare(
            `SELECT first_id FROM day_marks WHERE account_id = ? AND chat_id = ? AND day >= ?
             ORDER BY day LIMIT 1`,
          )
          .bind(chat.account_id, chat.chat_id, Math.floor(since[index] / DAY)),
      ),
    );
    return results.map((result) => result.results[0]?.first_id ?? Number.MAX_SAFE_INTEGER);
  }

  /** An edit replaces the content; a message we never stored is stored now. */
  async upsertEditedMessage(message: StoredMessage, guard: Guard): Promise<void> {
    const [condition, ...guardValues] = guardSql(guard, message);
    await this.db
      .prepare(
        `INSERT INTO messages (${MESSAGE_COLUMNS.join(", ")})
         SELECT ${MESSAGE_COLUMNS.map(() => "?").join(", ")} WHERE ${condition}
         ON CONFLICT (account_id, chat_id, message_id) DO UPDATE SET
           text = excluded.text,
           text_lc = excluded.text_lc,
           edited_at = excluded.edited_at,
           quote = COALESCE(excluded.quote, quote),
           mentions_bot = MAX(mentions_bot, excluded.mentions_bot),
           file_kind = COALESCE(excluded.file_kind, file_kind),
           file_id = COALESCE(excluded.file_id, file_id),
           file_name = COALESCE(excluded.file_name, file_name),
           file_mime = COALESCE(excluded.file_mime, file_mime),
           file_size = COALESCE(excluded.file_size, file_size),
           album = COALESCE(excluded.album, album)`,
      )
      .bind(...messageValues(message), ...guardValues)
      .run();
  }

  /** The bot changed one of its own messages through the MCP. */
  async updateOutgoing(
    chat: ChatRef,
    messageId: number,
    change: { text?: string; buttons?: string | null; markChoice?: boolean },
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (change.text !== undefined) {
      const text = redactSecrets(change.text);
      sets.push("text = ?", "text_lc = ?");
      values.push(text, normalize(text));
    }
    if (change.buttons !== undefined) {
      sets.push("buttons = ?");
      values.push(change.buttons);
    }
    if (change.markChoice !== undefined) {
      sets.push("mark_choice = ?");
      values.push(change.markChoice ? 1 : 0);
    }
    if (!sets.length) return;
    sets.push("edited_at = ?");
    values.push(nowSeconds());
    await this.db
      .prepare(
        `UPDATE messages SET ${sets.join(", ")} WHERE account_id = ? AND chat_id = ? AND message_id = ?`,
      )
      .bind(...values, chat.account_id, chat.chat_id, messageId)
      .run();
  }

  /**
   * A session is waiting for an answer to its message until `until`: a reply
   * in the meantime is the waiter's to take, not a new task. Written when a
   * wait starts and, if an answer comes early, when it ends — never per poll.
   * Messages no session sent carry nothing to route, so they cost no write.
   */
  async markAwaited(
    chat: ChatRef,
    messageId: number,
    until: number,
    change: "start" | "end",
  ): Promise<void> {
    const value =
      change === "start"
        ? "MAX(COALESCE(awaited_until, 0), ?)"
        : "MIN(COALESCE(awaited_until, ?), ?)";
    await this.db
      .prepare(
        `UPDATE messages SET awaited_until = ${value}
         WHERE account_id = ? AND chat_id = ? AND message_id = ? AND outgoing = 1
           AND session_id IS NOT NULL`,
      )
      .bind(
        ...(change === "start" ? [until] : [until, until]),
        chat.account_id,
        chat.chat_id,
        messageId,
      )
      .run();
  }

  async getMessage(chat: ChatRef, messageId: number): Promise<StoredMessage | null> {
    const row = await this.db
      .prepare("SELECT * FROM messages WHERE account_id = ? AND chat_id = ? AND message_id = ?")
      .bind(chat.account_id, chat.chat_id, messageId)
      .first<MessageRow>();
    return row ? toMessage(row) : null;
  }

  /** Several messages of one chat by id, in one primary-key query. */
  async getMessages(chat: ChatRef, messageIds: number[]): Promise<StoredMessage[]> {
    const ids = [...new Set(messageIds)].slice(0, 90);
    if (!ids.length) return [];
    const { results } = await this.db
      .prepare(
        `SELECT * FROM messages WHERE account_id = ? AND chat_id = ?
         AND message_id IN (${ids.map(() => "?").join(", ")})`,
      )
      .bind(chat.account_id, chat.chat_id, ...ids)
      .all<MessageRow>();
    return results.map(toMessage);
  }

  /** The rest of an album, oldest first: Telegram sends its items one after another, at most ten. */
  async albumOf(message: StoredMessage): Promise<StoredMessage[]> {
    if (!message.album) return [message];
    const { results } = await this.db
      .prepare(
        `SELECT * FROM messages WHERE account_id = ? AND chat_id = ? AND album = ?
         AND message_id BETWEEN ? AND ? ORDER BY message_id`,
      )
      .bind(
        message.account_id,
        message.chat_id,
        message.album,
        message.message_id - ALBUM_SPAN,
        message.message_id + ALBUM_SPAN,
      )
      .all<MessageRow>();
    return results.length ? results.map(toMessage) : [message];
  }

  /** Forget messages, with their presses and reactions (which only the bot's account has). */
  async deleteMessages(chat: ChatRef, messageIds: number[]): Promise<void> {
    const ids = [...new Set(messageIds)].slice(0, 90);
    if (!ids.length) return;
    const list = ids.map(() => "?").join(", ");
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM messages WHERE account_id = ? AND chat_id = ? AND message_id IN (${list})`,
        )
        .bind(chat.account_id, chat.chat_id, ...ids),
      ...(chat.account_id === BOT_ACCOUNT
        ? ["button_presses", "reactions"].map((table) =>
            this.db
              .prepare(`DELETE FROM ${table} WHERE chat_id = ? AND message_id IN (${list})`)
              .bind(chat.chat_id, ...ids),
          )
        : []),
    ]);
  }

  /** idFloors, skipping the lookup for windows that start at the beginning. */
  private async windowFloors(chats: ChatRef[], starts: number[]): Promise<number[]> {
    const needed = chats.map((_, index) => index).filter((index) => starts[index] > 0);
    const floors = chats.map(() => 0);
    const found = await this.idFloors(
      needed.map((index) => chats[index]),
      needed.map((index) => starts[index]),
    );
    needed.forEach((index, position) => (floors[index] = found[position]));
    return floors;
  }

  async search(query: SearchQuery): Promise<StoredMessage[]> {
    const scopes = query.scopes.slice(0, MAX_SCOPES);
    if (!scopes.length) return [];

    const where: string[] = [];
    const values: unknown[] = [];

    // Each chat is scanned from the first message of the window's first day.
    const starts = scopes.map((scope) => Math.max(scope.visible_from, query.since ?? 0));
    const floors = await this.windowFloors(scopes, starts);
    where.push(
      `(${scopes
        .map(() => "(account_id = ? AND chat_id = ? AND message_id >= ? AND date >= ?)")
        .join(" OR ")})`,
    );
    scopes.forEach((scope, index) =>
      values.push(scope.account_id, scope.chat_id, floors[index], starts[index]),
    );

    for (const keyword of query.keywords.slice(0, 10)) {
      where.push("text_lc LIKE ? ESCAPE '\\'");
      values.push(likePattern(keyword));
    }

    if (query.from) {
      const from = query.from.trim().replace(/^@/, "");
      if (/^-?\d+$/.test(from)) {
        where.push("from_id = ?");
        values.push(Number(from));
      } else {
        where.push("(lower(from_username) = lower(?) OR instr(from_name, ?) > 0)");
        values.push(from, from);
      }
    }
    if (query.mentionsOnly) where.push("mentions_bot = 1");
    if (query.hasFile) where.push("file_id IS NOT NULL");
    if (query.fileKind) {
      where.push("file_kind = ?");
      values.push(query.fileKind);
    }
    if (query.threadId !== undefined) {
      where.push("thread_id = ?");
      values.push(query.threadId);
    }
    if (query.direction === "incoming") where.push("outgoing = 0");
    if (query.direction === "outgoing") where.push("outgoing = 1");
    if (query.since !== undefined) {
      where.push("date >= ?");
      values.push(query.since);
    }
    if (query.until !== undefined) {
      where.push("date <= ?");
      values.push(query.until);
    }

    const { results } = await this.db
      .prepare(
        `SELECT * FROM messages WHERE ${where.join(" AND ")}
         ORDER BY date DESC, message_id DESC LIMIT ?`,
      )
      .bind(...values, query.limit)
      .all<MessageRow>();
    return results.map(toMessage);
  }

  /** Newest first, walking the primary key backwards from `beforeId`. */
  async recent(
    scope: Scope,
    options: { limit: number; beforeId?: number; since?: number; threadId?: number },
  ): Promise<StoredMessage[]> {
    const start = Math.max(scope.visible_from, options.since ?? 0);
    const [floor] = await this.windowFloors([scope], [start]);
    const { results } = await this.db
      .prepare(
        `SELECT * FROM messages
         WHERE account_id = ?7 AND chat_id = ?1 AND message_id < ?2 AND message_id >= ?6
           AND date >= ?3 AND (?5 IS NULL OR thread_id = ?5)
         ORDER BY message_id DESC LIMIT ?4`,
      )
      .bind(
        scope.chat_id,
        options.beforeId ?? Number.MAX_SAFE_INTEGER,
        start,
        options.limit,
        options.threadId ?? null,
        floor,
        scope.account_id,
      )
      .all<MessageRow>();
    return results.map(toMessage);
  }

  /** Oldest first, forward from `afterId`. */
  async after(
    scope: Scope,
    afterId: number,
    limit: number,
    threadId?: number,
  ): Promise<StoredMessage[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM messages
         WHERE account_id = ?6 AND chat_id = ?1 AND message_id > ?2 AND date >= ?3
           AND (?5 IS NULL OR thread_id = ?5)
         ORDER BY message_id ASC LIMIT ?4`,
      )
      .bind(scope.chat_id, afterId, scope.visible_from, limit, threadId ?? null, scope.account_id)
      .all<MessageRow>();
    return results.map(toMessage);
  }

  /**
   * The first answer to `messageId`: a reply to it, or — when `fromId` is
   * given, in a private chat — anything that person wrote after it.
   */
  async answerTo(
    scope: Scope,
    messageId: number,
    fromId: number | null,
  ): Promise<StoredMessage | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM messages
         WHERE account_id = ?5 AND chat_id = ?1 AND message_id > ?2 AND date >= ?3 AND outgoing = 0
           AND (reply_to_id = ?2 OR from_id = ?4)
         ORDER BY message_id ASC LIMIT 1`,
      )
      .bind(scope.chat_id, messageId, scope.visible_from, fromId ?? 0, scope.account_id)
      .first<MessageRow>();
    return row ? toMessage(row) : null;
  }

  /** The bot's latest message in a chat, looking back over the last few days only. */
  /** Whether a session is waiting for an answer in this private chat, or was since `since`. */
  async awaitedIn(chatId: number, since: number): Promise<boolean> {
    const chat = { account_id: BOT_ACCOUNT, chat_id: chatId };
    const [floor] = await this.idFloors([chat], [nowSeconds() - DAY]);
    const row = await this.db
      .prepare(
        `SELECT 1 FROM messages
         WHERE account_id = ? AND chat_id = ? AND message_id >= ? AND outgoing = 1 AND awaited_until >= ?
         LIMIT 1`,
      )
      .bind(chat.account_id, chat.chat_id, floor, since)
      .first();
    return row !== null;
  }

  async lastOutgoing(chat: ChatRef): Promise<StoredMessage | null> {
    const [floor] = await this.idFloors([chat], [nowSeconds() - 3 * DAY]);
    const row = await this.db
      .prepare(
        `SELECT * FROM messages
         WHERE account_id = ? AND chat_id = ? AND message_id >= ? AND outgoing = 1
         ORDER BY message_id DESC LIMIT 1`,
      )
      .bind(chat.account_id, chat.chat_id, floor)
      .first<MessageRow>();
    return row ? toMessage(row) : null;
  }

  /**
   * When the other side last wrote in a personal chat. Telegram lets a
   * business bot reply only within 24 hours of that, so this is read before
   * sending; it walks back from the newest message, so it costs little.
   */
  async lastIncoming(chat: ChatRef): Promise<StoredMessage | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM messages WHERE account_id = ? AND chat_id = ? AND outgoing = 0
         ORDER BY message_id DESC LIMIT 1`,
      )
      .bind(chat.account_id, chat.chat_id)
      .first<MessageRow>();
    return row ? toMessage(row) : null;
  }

  /** Keyed by refKey. */
  async lastMessageDates(chats: ChatRef[]): Promise<Map<string, number>> {
    const dates = new Map<string, number>();
    if (!chats.length) return dates;
    // One query per chat: each is a single primary-key probe from the end.
    const rows = await this.db.batch<ChatRef & { date: number }>(
      chats.map((chat) =>
        this.db
          .prepare(
            `SELECT account_id, chat_id, date FROM messages WHERE account_id = ? AND chat_id = ?
             ORDER BY message_id DESC LIMIT 1`,
          )
          .bind(chat.account_id, chat.chat_id),
      ),
    );
    for (const result of rows) {
      const row = result.results[0];
      if (row) dates.set(refKey(row), row.date);
    }
    return dates;
  }

  // --- buttons and reactions -----------------------------------------------

  async insertPress(press: PressRow): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO button_presses (chat_id, message_id, callback_id, user_id, user_name, label, data, date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        press.chat_id,
        press.message_id,
        press.callback_id,
        press.user_id,
        press.user_name,
        press.label,
        press.data,
        press.date,
      )
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async pressesFor(chatId: number, messageId: number): Promise<PressRow[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM button_presses WHERE chat_id = ? AND message_id = ? ORDER BY date, callback_id",
      )
      .bind(chatId, messageId)
      .all<PressRow>();
    return results;
  }

  async setReaction(reaction: ReactionRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO reactions (chat_id, message_id, user_id, user_name, emoji, date)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (chat_id, message_id, user_id) DO UPDATE SET
           emoji = excluded.emoji, user_name = excluded.user_name, date = excluded.date`,
      )
      .bind(
        reaction.chat_id,
        reaction.message_id,
        reaction.user_id,
        reaction.user_name,
        reaction.emoji,
        reaction.date,
      )
      .run();
  }

  async deleteReaction(chatId: number, messageId: number, userId: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM reactions WHERE chat_id = ? AND message_id = ? AND user_id = ?")
      .bind(chatId, messageId, userId)
      .run();
  }

  async reactionsFor(chatId: number, messageId: number): Promise<ReactionRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM reactions WHERE chat_id = ? AND message_id = ? ORDER BY date")
      .bind(chatId, messageId)
      .all<ReactionRow>();
    return results;
  }

  // --- forum topics --------------------------------------------------------

  /** Costs a write only when the name is new or changed. */
  async upsertTopic(chatId: number, threadId: number, name: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO topics (chat_id, thread_id, name, updated_at)
         SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM grants WHERE chat_id = ?1)
         ON CONFLICT (chat_id, thread_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
         WHERE name <> excluded.name`,
      )
      .bind(chatId, threadId, name, nowSeconds())
      .run();
  }

  async topics(chatIds: number[]): Promise<TopicRow[]> {
    if (!chatIds.length) return [];
    const ids = chatIds.slice(0, 90);
    const { results } = await this.db
      .prepare(
        `SELECT chat_id, thread_id, name FROM topics WHERE chat_id IN (${ids.map(() => "?").join(", ")})
         ORDER BY chat_id, name`,
      )
      .bind(...ids)
      .all<TopicRow>();
    return results;
  }

  // --- business connections and personal chats -----------------------------

  getBusinessConnection(userId: number): Promise<BusinessRow | null> {
    return this.db
      .prepare("SELECT * FROM business_connections WHERE user_id = ?")
      .bind(userId)
      .first<BusinessRow>();
  }

  businessConnectionById(connectionId: string): Promise<BusinessRow | null> {
    return this.db
      .prepare("SELECT * FROM business_connections WHERE connection_id = ?")
      .bind(connectionId)
      .first<BusinessRow>();
  }

  /**
   * Record a connection as Telegram reports it. A user has one connection
   * with the bot at a time; a new id (they reconnected) replaces the old one.
   */
  async upsertBusinessConnection(row: {
    user_id: number;
    connection_id: string;
    rights: string;
    enabled: boolean;
  }): Promise<void> {
    const now = nowSeconds();
    await this.db.batch([
      // A stale row of another user can hold this id only if Telegram reused it; it must go.
      this.db
        .prepare("DELETE FROM business_connections WHERE connection_id = ? AND user_id <> ?")
        .bind(row.connection_id, row.user_id),
      this.db
        .prepare(
          `INSERT INTO business_connections (user_id, connection_id, rights, enabled, connected_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5)
           ON CONFLICT (user_id) DO UPDATE SET
             connection_id = excluded.connection_id,
             rights = excluded.rights,
             enabled = excluded.enabled,
             updated_at = excluded.updated_at`,
        )
        .bind(row.user_id, row.connection_id, row.rights, row.enabled ? 1 : 0, now),
    ]);
  }

  /** The connection is gone: forget it and every personal message it brought, in one go. */
  async dropPersonal(accountId: number): Promise<void> {
    if (accountId === BOT_ACCOUNT) return;
    await this.db.batch([
      this.db.prepare("DELETE FROM business_connections WHERE user_id = ?").bind(accountId),
      ...[...ACCOUNT_TABLES, "personal_chats"].map((table) =>
        this.db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).bind(accountId),
      ),
    ]);
  }

  /** Users with a stored business connection, for dropping those no longer allowed. */
  async businessUsers(): Promise<number[]> {
    const { results } = await this.db
      .prepare("SELECT user_id FROM business_connections")
      .all<{ user_id: number }>();
    return results.map((row) => row.user_id);
  }

  /** Who a personal chat is with. Costs a write only when the name changed. */
  async upsertPersonalChat(chat: PersonalChatRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO personal_chats (account_id, chat_id, title, username, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5 WHERE ${personalOn("?1")}
         ON CONFLICT (account_id, chat_id) DO UPDATE SET
           title = excluded.title, username = excluded.username, updated_at = excluded.updated_at
         WHERE title IS NOT excluded.title OR username IS NOT excluded.username`,
      )
      .bind(chat.account_id, chat.chat_id, chat.title, chat.username, nowSeconds())
      .run();
  }

  async listPersonalChats(accountId: number): Promise<PersonalChatRow[]> {
    const { results } = await this.db
      .prepare(
        "SELECT account_id, chat_id, title, username FROM personal_chats WHERE account_id = ?",
      )
      .bind(accountId)
      .all<PersonalChatRow>();
    return results;
  }

  // --- upload nonces -------------------------------------------------------

  /** True the first time a nonce is seen; false on any replay. */
  async useNonce(nonce: string, expiresAt: number): Promise<boolean> {
    const result = await this.db
      .prepare("INSERT INTO upload_nonces (nonce, expires_at) VALUES (?, ?) ON CONFLICT DO NOTHING")
      .bind(nonce, expiresAt)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  // --- memory ---------------------------------------------------------------

  getMemory(userId: number, chatId: number): Promise<MemoryDoc | null> {
    return this.db
      .prepare("SELECT * FROM memory_docs WHERE user_id = ? AND chat_id = ?")
      .bind(userId, chatId)
      .first<MemoryDoc>();
  }

  async listMemory(
    userId: number,
  ): Promise<{ chat_id: number; length: number; updated_at: number }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT chat_id, length(content) AS length, updated_at FROM memory_docs
         WHERE user_id = ? ORDER BY updated_at DESC`,
      )
      .bind(userId)
      .all<{ chat_id: number; length: number; updated_at: number }>();
    return results;
  }

  /**
   * Replace a document (null deletes it), keeping what it read before for
   * undo. Returns the id of that history entry.
   */
  async writeMemory(
    userId: number,
    chatId: number,
    content: string | null,
    by: string | null,
  ): Promise<number> {
    const now = nowSeconds();
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO memory_history (user_id, chat_id, content_before, changed_at, changed_by)
           VALUES (?1, ?2, (SELECT content FROM memory_docs WHERE user_id = ?1 AND chat_id = ?2), ?3, ?4)
           RETURNING id`,
        )
        .bind(userId, chatId, now, by),
      content === null
        ? this.db
            .prepare("DELETE FROM memory_docs WHERE user_id = ? AND chat_id = ?")
            .bind(userId, chatId)
        : this.db
            .prepare(
              `INSERT INTO memory_docs (user_id, chat_id, content, updated_at, updated_by)
               VALUES (?1, ?2, ?3, ?4, ?5)
               ON CONFLICT (user_id, chat_id) DO UPDATE SET
                 content = excluded.content,
                 updated_at = excluded.updated_at,
                 updated_by = excluded.updated_by`,
            )
            .bind(userId, chatId, content, now, by),
      this.db
        .prepare(
          `DELETE FROM memory_history WHERE user_id = ?1 AND chat_id = ?2 AND id NOT IN (
             SELECT id FROM memory_history WHERE user_id = ?1 AND chat_id = ?2
             ORDER BY id DESC LIMIT ?3)`,
        )
        .bind(userId, chatId, MEMORY_VERSIONS),
    ]);
    return (results[0].results[0] as { id: number }).id;
  }

  getMemoryChange(userId: number, id: number): Promise<MemoryChange | null> {
    return this.db
      .prepare("SELECT * FROM memory_history WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .first<MemoryChange>();
  }

  /** How many changes the document had after history entry `id`. */
  async memoryChangesAfter(userId: number, chatId: number, id: number): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_history WHERE user_id = ? AND chat_id = ? AND id > ?",
      )
      .bind(userId, chatId, id)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** One chat's memory, with its history and notices: nothing left to undo. */
  async deleteMemory(userId: number, chatId: number): Promise<void> {
    await this.db.batch(
      USER_CHAT_TABLES.map((table) =>
        this.db
          .prepare(`DELETE FROM ${table} WHERE user_id = ? AND chat_id = ?`)
          .bind(userId, chatId),
      ),
    );
  }

  /** The user's whole memory, with its history and notices. */
  async wipeMemory(userId: number): Promise<void> {
    await this.db.batch(
      USER_CHAT_TABLES.map((table) =>
        this.db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId),
      ),
    );
  }

  getMemoryNotice(userId: number, chatId: number, client: string): Promise<MemoryNotice | null> {
    return this.db
      .prepare("SELECT * FROM memory_notices WHERE user_id = ? AND chat_id = ? AND client = ?")
      .bind(userId, chatId, client)
      .first<MemoryNotice>();
  }

  async setMemoryNotice(notice: MemoryNotice): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO memory_notices (user_id, chat_id, client, message_id, first_history_id, sent_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (user_id, chat_id, client) DO UPDATE SET
           message_id = excluded.message_id,
           first_history_id = excluded.first_history_id,
           sent_at = excluded.sent_at`,
      )
      .bind(
        notice.user_id,
        notice.chat_id,
        notice.client,
        notice.message_id,
        notice.first_history_id,
        notice.sent_at,
      )
      .run();
  }

  /** A notice was acted on: the next change gets a notice of its own. */
  async dropMemoryNotice(userId: number, messageId: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM memory_notices WHERE user_id = ? AND message_id = ?")
      .bind(userId, messageId)
      .run();
  }

  // --- routines ------------------------------------------------------------

  getRoutine(userId: number): Promise<Routine | null> {
    return this.db
      .prepare("SELECT * FROM routines WHERE user_id = ?")
      .bind(userId)
      .first<Routine>();
  }

  async setRoutine(userId: number, triggerId: string, tokenEnc: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO routines (user_id, trigger_id, token_enc, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (user_id) DO UPDATE SET
           trigger_id = excluded.trigger_id, token_enc = excluded.token_enc,
           updated_at = excluded.updated_at, test_session = NULL, test_at = NULL`,
      )
      .bind(userId, triggerId, tokenEnc, nowSeconds())
      .run();
  }

  async setRoutineTest(userId: number, sessionId: string): Promise<void> {
    await this.db
      .prepare("UPDATE routines SET test_session = ?, test_at = ? WHERE user_id = ?")
      .bind(sessionId, nowSeconds(), userId)
      .run();
  }

  /** Whether this session has sent anything to the chat since `since` — a test start answering. */
  async sessionSpokeIn(chatId: number, sessionId: string, since: number): Promise<boolean> {
    const chat = { account_id: BOT_ACCOUNT, chat_id: chatId };
    const [floor] = await this.idFloors([chat], [since]);
    const row = await this.db
      .prepare(
        `SELECT 1 FROM messages
         WHERE account_id = ? AND chat_id = ? AND message_id >= ? AND outgoing = 1 AND session_id = ?
         LIMIT 1`,
      )
      .bind(chat.account_id, chat.chat_id, floor, sessionId)
      .first();
    return row !== null;
  }

  async deleteRoutine(userId: number): Promise<void> {
    await this.db.prepare("DELETE FROM routines WHERE user_id = ?").bind(userId).run();
  }

  // --- where Claude answers -------------------------------------------------

  getClaudeChat(chatId: number): Promise<ClaudeChat | null> {
    return this.db
      .prepare("SELECT * FROM claude_chats WHERE chat_id = ?")
      .bind(chatId)
      .first<ClaudeChat>();
  }

  /** Claude answers in the chat for this user, if nobody holds it yet. True when it is theirs. */
  async claimClaudeChat(userId: number, chatId: number): Promise<boolean> {
    await this.db
      .prepare(
        `INSERT INTO claude_chats (chat_id, user_id, since) VALUES (?, ?, ?)
         ON CONFLICT (chat_id) DO NOTHING`,
      )
      .bind(chatId, userId, nowSeconds())
      .run();
    return (await this.getClaudeChat(chatId))?.user_id === userId;
  }

  async releaseClaudeChat(userId: number, chatId: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM claude_chats WHERE chat_id = ? AND user_id = ?")
      .bind(chatId, userId)
      .run();
  }

  async setClaudeOthersLimit(userId: number, chatId: number, limit: number): Promise<void> {
    await this.db
      .prepare("UPDATE claude_chats SET others_limit = ? WHERE chat_id = ? AND user_id = ?")
      .bind(limit, chatId, userId)
      .run();
  }

  async setClaudeOthers(userId: number, chatId: number, others: boolean): Promise<void> {
    await this.db
      .prepare("UPDATE claude_chats SET others = ? WHERE chat_id = ? AND user_id = ?")
      .bind(others ? 1 : 0, chatId, userId)
      .run();
  }

  /**
   * Some of the chats where Claude answers, for the daily check of their
   * holders. Random, and capped: each check of a group is a Bot API call, and
   * a Worker run makes only so many.
   */
  async someClaudeChats(limit: number): Promise<ClaudeChat[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM claude_chats ORDER BY RANDOM() LIMIT ?")
      .bind(limit)
      .all<ClaudeChat>();
    return results;
  }

  /** The chats where Claude answers for this user, and whether others may start it there. */
  async claudeChatsOf(userId: number): Promise<Map<number, boolean>> {
    const { results } = await this.db
      .prepare("SELECT chat_id, others FROM claude_chats WHERE user_id = ?")
      .bind(userId)
      .all<{ chat_id: number; others: number }>();
    return new Map(results.map((row) => [row.chat_id, row.others === 1]));
  }

  async dropClaudeChats(userId: number): Promise<void> {
    await this.db.prepare("DELETE FROM claude_chats WHERE user_id = ?").bind(userId).run();
  }

  // --- starts --------------------------------------------------------------

  /**
   * Claim the start for this message, within the hourly limits, in one
   * statement: Telegram delivers updates in parallel, and a burst of tags
   * checked first and written after would all pass. Failed starts do not
   * count against the limits.
   */
  async beginFire(
    fire: FireEntry,
    limits: { user: number; others: number },
  ): Promise<"claimed" | "again" | "limit"> {
    const now = nowSeconds();
    const result = await this.db
      .prepare(
        `INSERT INTO fires (chat_id, message_id, user_id, by_other, status, at, from_name, excerpt, album)
         SELECT ?1, ?2, ?3, ?4, 'pending', ?5, ?9, ?10, ?11
         WHERE (SELECT COUNT(*) FROM fires WHERE user_id = ?3 AND at >= ?6
                AND (status IN ('pending', 'started') OR (status = 'relayed' AND by_other = 1))) < ?7
           AND (?4 = 0 OR (SELECT COUNT(*) FROM fires
                WHERE user_id = ?3 AND at >= ?6 AND chat_id = ?1 AND by_other = 1
                  AND status IN ('pending', 'started', 'relayed')) < ?8)
           AND (?11 IS NULL OR NOT EXISTS (SELECT 1 FROM fires WHERE chat_id = ?1 AND album = ?11))
         ON CONFLICT (chat_id, message_id) DO NOTHING`,
      )
      .bind(
        fire.chatId,
        fire.messageId,
        fire.userId,
        fire.byOther ? 1 : 0,
        now,
        now - 3600,
        limits.user,
        limits.others,
        fire.fromName,
        fire.excerpt,
        fire.album,
      )
      .run();
    if ((result.meta.changes ?? 0) > 0) return "claimed";
    const seen = await this.db
      .prepare("SELECT 1 FROM fires WHERE chat_id = ?1 AND (message_id = ?2 OR album = ?3) LIMIT 1")
      .bind(fire.chatId, fire.messageId, fire.album)
      .first();
    return seen ? "again" : "limit";
  }

  async endFire(
    chatId: number,
    messageId: number,
    outcome: { status: "started" | "relayed"; sessionId: string } | { status: "failed" | "joined" },
  ): Promise<void> {
    await this.db
      .prepare("UPDATE fires SET status = ?, session_id = ? WHERE chat_id = ? AND message_id = ?")
      .bind(outcome.status, "sessionId" in outcome ? outcome.sessionId : null, chatId, messageId)
      .run();
  }

  /**
   * Record a start held back by the limit. True when it is the first in this
   * chat within the hour: the holder hears about it once, not per message.
   */
  async noteLimited(fire: FireEntry): Promise<boolean> {
    const now = nowSeconds();
    const [earlier] = await this.db.batch([
      this.db
        .prepare(
          "SELECT 1 FROM fires WHERE chat_id = ? AND by_other = ? AND status = 'limited' AND at >= ? LIMIT 1",
        )
        .bind(fire.chatId, fire.byOther ? 1 : 0, now - 3600),
      this.db
        .prepare(
          `INSERT INTO fires (chat_id, message_id, user_id, by_other, status, at, from_name, excerpt, album)
           VALUES (?, ?, ?, ?, 'limited', ?, ?, ?, ?) ON CONFLICT (chat_id, message_id) DO NOTHING`,
        )
        .bind(
          fire.chatId,
          fire.messageId,
          fire.userId,
          fire.byOther ? 1 : 0,
          now,
          fire.fromName,
          fire.excerpt,
          fire.album,
        ),
    ]);
    return earlier.results.length === 0;
  }

  /**
   * The holder's latest starts in a chat, newest first: the chat's log. Tags
   * held back by the limit are only counted, so a flood of them cannot push
   * the real starts out of sight.
   */
  async firesIn(
    userId: number,
    chatId: number,
    limit: number,
    since: number,
  ): Promise<{ fires: FireRow[]; limited: number }> {
    const [fires, limited] = await this.db.batch([
      this.db
        .prepare(
          `SELECT message_id, status, session_id, at, from_name, excerpt FROM fires
           WHERE chat_id = ? AND user_id = ? AND status != 'limited'
           ORDER BY at DESC, message_id DESC LIMIT ?`,
        )
        .bind(chatId, userId, limit),
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM fires WHERE chat_id = ? AND user_id = ? AND status = 'limited' AND at >= ?",
        )
        .bind(chatId, userId, since),
    ]);
    return {
      fires: fires.results as FireRow[],
      limited: (limited.results[0] as { n: number } | undefined)?.n ?? 0,
    };
  }

  /**
   * A start for an earlier message in this chat since `since`: a session about
   * to read this one along. Earlier only — two messages handled at once must
   * not both wait on the other.
   */
  async recentStart(chatId: number, messageId: number, since: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 FROM fires WHERE chat_id = ? AND message_id < ? AND at >= ?
         AND status IN ('pending', 'started') LIMIT 1`,
      )
      .bind(chatId, messageId, since)
      .first();
    return row !== null;
  }

  /** The session the holder's messages in this chat went to most recently since `since`. */
  async latestSession(userId: number, chatId: number, since: number): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT session_id FROM fires WHERE user_id = ? AND at >= ? AND chat_id = ?
         AND status IN ('started', 'relayed') AND session_id IS NOT NULL
         ORDER BY at DESC, message_id DESC LIMIT 1`,
      )
      .bind(userId, since, chatId)
      .first<{ session_id: string }>();
    return row?.session_id ?? null;
  }

  /** Whether other members' starts already failed in this chat since `since`: the holder heard once. */
  async othersFailedSince(userId: number, chatId: number, since: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 FROM fires WHERE user_id = ? AND at >= ? AND chat_id = ? AND by_other = 1
         AND status = 'failed' LIMIT 1`,
      )
      .bind(userId, since, chatId)
      .first();
    return row !== null;
  }

  async routineUsers(): Promise<number[]> {
    const { results } = await this.db
      .prepare("SELECT user_id FROM routines")
      .all<{ user_id: number }>();
    return results.map((row) => row.user_id);
  }

  /** Users with any memory, for dropping those no longer allowed. */
  async memoryUsers(): Promise<number[]> {
    const { results } = await this.db
      .prepare("SELECT DISTINCT user_id FROM memory_docs")
      .all<{ user_id: number }>();
    return results.map((row) => row.user_id);
  }

  // --- relay ---------------------------------------------------------------

  async getRelay(userId: number): Promise<RelayRow | null> {
    return this.db.prepare("SELECT * FROM relays WHERE user_id = ?").bind(userId).first<RelayRow>();
  }

  async relayByToken(tokenHash: string): Promise<RelayRow | null> {
    return this.db
      .prepare("SELECT * FROM relays WHERE token_hash = ?")
      .bind(tokenHash)
      .first<RelayRow>();
  }

  /** A new token: the old one stops working at once. */
  async setRelay(userId: number, tokenHash: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO relays (user_id, token_hash, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash,
           created_at = excluded.created_at, last_seen = NULL, login_failed_at = NULL,
           offline_noticed_at = NULL`,
      )
      .bind(userId, tokenHash, nowSeconds())
      .run();
  }

  /** Removes the relay; the jobs it had not done fail and are returned. */
  async deleteRelay(userId: number): Promise<RelayJob[]> {
    const [, failed] = await this.db.batch([
      this.db.prepare("DELETE FROM relays WHERE user_id = ?").bind(userId),
      this.db
        .prepare(
          `UPDATE relay_jobs SET status = 'failed', error = 'the relay was turned off'
           WHERE user_id = ? AND status IN ('queued', 'taken') RETURNING *`,
        )
        .bind(userId),
    ]);
    return failed.results as RelayJob[];
  }

  /** The relay asked for work: it is alive. Written at most every 30 s. */
  async touchRelay(userId: number, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE relays SET last_seen = ?1, offline_noticed_at = NULL
         WHERE user_id = ?2 AND (last_seen IS NULL OR last_seen < ?1 - 30)`,
      )
      .bind(now, userId)
      .run();
  }

  async setRelayLogin(userId: number, failedAt: number | null): Promise<void> {
    await this.db
      .prepare("UPDATE relays SET login_failed_at = ? WHERE user_id = ?")
      .bind(failedAt, userId)
      .run();
  }

  /** True when this call marked the relay as gone quiet: the user hears once per outage. */
  async noteRelayOffline(userId: number, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE relays SET offline_noticed_at = ? WHERE user_id = ? AND offline_noticed_at IS NULL",
      )
      .bind(now, userId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async enqueueJob(
    job: Pick<
      RelayJob,
      | "id"
      | "user_id"
      | "target_session"
      | "body"
      | "origin"
      | "from_session"
      | "chat_id"
      | "message_id"
      | "thread_id"
      | "wants_answer"
      | "kind"
    >,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO relay_jobs (id, user_id, target_session, body, origin, from_session,
           chat_id, message_id, thread_id, wants_answer, kind, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .bind(
        job.id,
        job.user_id,
        job.target_session,
        job.body,
        job.origin,
        job.from_session,
        job.chat_id,
        job.message_id,
        job.thread_id,
        job.wants_answer,
        job.kind,
        nowSeconds(),
      )
      .run();
  }

  /** Hand the oldest queued jobs to the relay, each once. */
  async takeJobs(userId: number, limit: number): Promise<RelayJob[]> {
    const { results } = await this.db
      .prepare(
        `UPDATE relay_jobs SET status = 'taken', taken_at = ?1
         WHERE id IN (SELECT id FROM relay_jobs WHERE user_id = ?2 AND status = 'queued'
                      ORDER BY created_at, message_id LIMIT ?3)
         RETURNING *`,
      )
      .bind(nowSeconds(), userId, limit)
      .all<RelayJob>();
    return results.sort(
      (a, b) => a.created_at - b.created_at || (a.message_id ?? 0) - (b.message_id ?? 0),
    );
  }

  /** The relay's report on a job it took; null when it was not that relay's or not taken. */
  async finishJob(
    userId: number,
    id: string,
    outcome: { ok: boolean; error: string | null },
  ): Promise<RelayJob | null> {
    return this.db
      .prepare(
        `UPDATE relay_jobs SET status = ?, error = ?
         WHERE id = ? AND user_id = ? AND status = 'taken' RETURNING *`,
      )
      .bind(outcome.ok ? "done" : "failed", outcome.ok ? null : outcome.error, id, userId)
      .first<RelayJob>();
  }

  /**
   * Jobs gone stale fail now: queued ones nobody took since `queuedBefore`
   * (the relay is gone), and taken ones never reported since `takenBefore`
   * (it restarted or lost the report).
   */
  async expireJobs(queuedBefore: number, takenBefore: number): Promise<RelayJob[]> {
    const { results } = await this.db
      .prepare(
        `UPDATE relay_jobs SET status = 'failed', error = CASE status
           WHEN 'queued' THEN 'the relay did not pick it up' ELSE 'the relay did not report back' END
         WHERE (status = 'queued' AND created_at < ?) OR (status = 'taken' AND taken_at < ?)
         RETURNING *`,
      )
      .bind(queuedBefore, takenBefore)
      .all<RelayJob>();
    return results;
  }

  /**
   * The day's messages still queued for a session that turned out gone: they
   * fail too, and the session started in its place reads them along.
   */
  async foldDayJobs(userId: number, session: string): Promise<RelayJob[]> {
    const { results } = await this.db
      .prepare(
        `UPDATE relay_jobs SET status = 'failed', error = 'its session was gone; the new one reads it'
         WHERE user_id = ? AND target_session = ? AND kind = 'day' AND status = 'queued' RETURNING *`,
      )
      .bind(userId, session)
      .all<RelayJob>();
    return results;
  }

  async getJob(userId: number, id: string): Promise<RelayJob | null> {
    return this.db
      .prepare("SELECT * FROM relay_jobs WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .first<RelayJob>();
  }

  /** The first answer stands. False when there is no such question, it wants none, or it was answered. */
  async answerJob(userId: number, id: string, answer: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE relay_jobs SET answer = ?, answered_at = ?
         WHERE id = ? AND user_id = ? AND answer IS NULL AND wants_answer = 1`,
      )
      .bind(redactSecrets(answer), nowSeconds(), id, userId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** Whether the user's routine started this session, and for whom. Null: not by a tag. */
  async sessionStart(userId: number, sessionId: string): Promise<{ by_other: boolean } | null> {
    const row = await this.db
      .prepare(
        "SELECT by_other FROM fires WHERE user_id = ? AND session_id = ? AND status = 'started' LIMIT 1",
      )
      .bind(userId, sessionId)
      .first<{ by_other: number }>();
    return row ? { by_other: row.by_other === 1 } : null;
  }

  /** Whether anyone but the user has had messages relayed into this session. */
  async sessionHeardOthers(userId: number, sessionId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT 1 FROM relay_jobs WHERE user_id = ? AND target_session = ? AND origin != 'user' LIMIT 1",
      )
      .bind(userId, sessionId)
      .first();
    return row !== null;
  }

  /** Sessions the bot knows of for this user, most recently heard of first. */
  async knownSessions(userId: number, limit: number): Promise<KnownSession[]> {
    const [started, wrote, asked] = await this.db.batch([
      this.db
        .prepare(
          `SELECT session_id, chat_id, at, from_name, excerpt, by_other FROM fires
           WHERE user_id = ? AND status = 'started' AND session_id IS NOT NULL
           ORDER BY at DESC LIMIT 200`,
        )
        .bind(userId),
      this.db
        .prepare(
          `SELECT session_id, chat_id, MAX(date) AS at, text FROM messages
           WHERE account_id = ? AND sent_by = ? AND session_id IS NOT NULL
           GROUP BY session_id ORDER BY at DESC LIMIT 200`,
        )
        .bind(BOT_ACCOUNT, userId),
      this.db
        .prepare(
          `SELECT target_session AS session_id, MAX(created_at) AS at FROM relay_jobs
           WHERE user_id = ? GROUP BY target_session ORDER BY at DESC LIMIT 200`,
        )
        .bind(userId),
    ]);
    const known = new Map<string, KnownSession>();
    const entry = (id: string) => known.get(id) ?? known.set(id, { session_id: id }).get(id)!;
    for (const row of started.results as {
      session_id: string;
      chat_id: number;
      at: number;
      from_name: string | null;
      excerpt: string | null;
      by_other: number;
    }[]) {
      const session = entry(row.session_id);
      session.started ??= { ...row, by_other: row.by_other === 1 };
    }
    for (const row of wrote.results as {
      session_id: string;
      chat_id: number;
      at: number;
      text: string;
    }[]) {
      entry(row.session_id).wrote = { chat_id: row.chat_id, at: row.at, text: row.text };
    }
    for (const row of asked.results as { session_id: string; at: number }[]) {
      entry(row.session_id).asked_at = row.at;
    }
    const last = (s: KnownSession) =>
      Math.max(s.started?.at ?? 0, s.wrote?.at ?? 0, s.asked_at ?? 0);
    return [...known.values()].sort((a, b) => last(b) - last(a)).slice(0, limit);
  }

  // --- refresh sessions ----------------------------------------------------

  /**
   * Move a session from `generation` to the next, if that is still current
   * and it is not revoked. A session with no row yet is at generation 0.
   * False when another refresh got there first, or the token is stale.
   */
  async advanceRefresh(
    id: string,
    userId: number,
    generation: number,
    expiresAt: number,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `INSERT INTO refresh_sessions (id, user_id, generation, rotated_at, expires_at)
         VALUES (?1, ?2, ?3 + 1, ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET
           generation = excluded.generation,
           rotated_at = excluded.rotated_at,
           expires_at = excluded.expires_at
         WHERE refresh_sessions.generation = ?3
           AND refresh_sessions.user_id = ?2
           AND refresh_sessions.revoked = 0
         RETURNING generation`,
      )
      .bind(id, userId, generation, nowSeconds(), expiresAt)
      .first<{ generation: number }>();
    return row !== null;
  }

  /** A new sign-in, at generation 0: what the code exchange hands out. */
  async createSignIn(
    id: string,
    userId: number,
    clientName: string | null,
    expiresAt: number,
  ): Promise<void> {
    const now = nowSeconds();
    await this.db
      .prepare(
        `INSERT INTO refresh_sessions (id, user_id, generation, rotated_at, expires_at, client_name, created_at)
         VALUES (?1, ?2, 0, ?3, ?4, ?5, ?3)`,
      )
      .bind(id, userId, now, expiresAt, clientName)
      .run();
  }

  /** The user's row and, when `sessionId` is given, whether that sign-in is revoked. */
  tokenState(userId: number, sessionId: string | null): Promise<TokenState | null> {
    return this.db
      .prepare(
        `SELECT u.token_version, u.connected_at, u.username, u.first_name,
                s.revoked AS session_revoked, s.client_name
         FROM users u
         LEFT JOIN refresh_sessions s ON s.id = ?2 AND s.user_id = u.user_id
         WHERE u.user_id = ?1`,
      )
      .bind(userId, sessionId)
      .first<TokenState>();
  }

  /** Sign-ins still standing, the most recently used first. */
  async listSignIns(userId: number): Promise<RefreshSessionRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM refresh_sessions
         WHERE user_id = ? AND revoked = 0 AND expires_at > ?
         ORDER BY rotated_at DESC`,
      )
      .bind(userId, nowSeconds())
      .all<RefreshSessionRow>();
    return results;
  }

  /** Ends one of the user's own sign-ins. False when it is not theirs or already ended. */
  async revokeSignIn(userId: number, id: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE refresh_sessions SET revoked = 1 WHERE id = ? AND user_id = ? AND revoked = 0",
      )
      .bind(id, userId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  getRefreshSession(id: string): Promise<RefreshSessionRow | null> {
    return this.db
      .prepare("SELECT * FROM refresh_sessions WHERE id = ?")
      .bind(id)
      .first<RefreshSessionRow>();
  }

  /** Every refresh token of the session stops working. */
  async revokeRefreshSession(id: string, userId: number, expiresAt: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO refresh_sessions (id, user_id, generation, rotated_at, expires_at, revoked)
         VALUES (?1, ?2, 0, ?3, ?4, 1)
         ON CONFLICT (id) DO UPDATE SET revoked = 1`,
      )
      .bind(id, userId, nowSeconds(), expiresAt)
      .run();
  }

  // --- retention -----------------------------------------------------------

  async purge(cutoff: number): Promise<number> {
    const results = await this.db.batch([
      this.db.prepare("DELETE FROM messages WHERE date < ?").bind(cutoff),
      this.db.prepare("DELETE FROM button_presses WHERE date < ?").bind(cutoff),
      this.db.prepare("DELETE FROM reactions WHERE date < ?").bind(cutoff),
      this.db.prepare("DELETE FROM upload_nonces WHERE expires_at < ?").bind(nowSeconds()),
      // A day past expiry: tokens can outlive their row by a few minutes, and
      // a session with no row would start afresh.
      this.db.prepare("DELETE FROM refresh_sessions WHERE expires_at < ?").bind(nowSeconds() - DAY),
      this.db.prepare("DELETE FROM day_marks WHERE day < ?").bind(Math.floor(cutoff / DAY)),
      this.db.prepare("DELETE FROM fires WHERE at < ?").bind(cutoff),
      this.db.prepare("DELETE FROM relay_jobs WHERE created_at < ?").bind(cutoff),
      // People nobody has heard from within retention.
      this.db.prepare(
        `DELETE FROM personal_chats WHERE NOT EXISTS (
           SELECT 1 FROM messages m
           WHERE m.account_id = personal_chats.account_id AND m.chat_id = personal_chats.chat_id
         )`,
      ),
    ]);
    return results[0].meta.changes ?? 0;
  }
}

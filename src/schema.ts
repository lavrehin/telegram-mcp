/**
 * Database schema, applied by the Worker itself.
 *
 * The deploy button creates the D1 database but runs no migrations, so the
 * Worker brings the schema up on first use: one read per isolate to check the
 * version, and the DDL only when it is behind. Every statement is idempotent,
 * so two isolates racing on a fresh database both succeed.
 *
 * Built to spend few writes, because D1 bills — and the free plan caps — rows
 * written per account per day, and every index entry is one more row:
 *   - `messages` has no secondary index. Per-chat reads walk the primary key
 *     (message ids grow within a chat); the daily purge scans, which costs
 *     only reads.
 *   - Small, rarely written tables (grants, presses) get the indexes they need.
 */

const SCHEMA_VERSION = 15;

const MESSAGES_COLUMNS = `
    account_id INTEGER NOT NULL DEFAULT 0,
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    date INTEGER NOT NULL,
    edited_at INTEGER,
    thread_id INTEGER,
    from_id INTEGER,
    from_name TEXT,
    from_username TEXT,
    forwarded_from TEXT,
    text TEXT NOT NULL DEFAULT '',
    text_lc TEXT NOT NULL DEFAULT '',
    reply_to_id INTEGER,
    quote TEXT,
    mentions_bot INTEGER NOT NULL DEFAULT 0,
    outgoing INTEGER NOT NULL DEFAULT 0,
    file_kind TEXT,
    file_id TEXT,
    file_name TEXT,
    file_mime TEXT,
    file_size INTEGER,
    buttons TEXT,
    mark_choice INTEGER NOT NULL DEFAULT 0,
    sent_by INTEGER,
    via_bot TEXT,
    as_chat INTEGER NOT NULL DEFAULT 0,
    session_id TEXT,
    awaited_until INTEGER,
    album TEXT,
    PRIMARY KEY (account_id, chat_id, message_id)`;

/** Every column of `messages` but account_id, as they stood before version 4. */
const V2_MESSAGE_COLUMNS =
  "chat_id, message_id, date, edited_at, thread_id, from_id, from_name, from_username, " +
  "forwarded_from, text, text_lc, reply_to_id, quote, mentions_bot, outgoing, file_kind, file_id, " +
  "file_name, file_mime, file_size, buttons, mark_choice, sent_by";

const DAY_MARKS_COLUMNS = `
    account_id INTEGER NOT NULL DEFAULT 0,
    chat_id INTEGER NOT NULL,
    day INTEGER NOT NULL,
    first_id INTEGER NOT NULL,
    PRIMARY KEY (account_id, chat_id, day)`;

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    language TEXT,
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    -- When the user first signed an assistant in. Only such users may link groups.
    connected_at INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS chats (
    chat_id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT,
    username TEXT,
    is_forum INTEGER NOT NULL DEFAULT 0,
    bot_is_admin INTEGER NOT NULL DEFAULT 0,
    visible_history INTEGER,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS grants (
    user_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    visible_from INTEGER NOT NULL,
    granted_at INTEGER NOT NULL,
    verified_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, chat_id)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS grants_by_chat ON grants (chat_id)`,

  // Keyed by the account the message belongs to, as in Telegram itself: message
  // ids count per account, and a business connection shows a user's private
  // chats under the other person's id. 0 is the bot's own account (its DM with
  // each user, and groups); otherwise the user whose personal chat it is.
  `CREATE TABLE IF NOT EXISTS messages (${MESSAGES_COLUMNS}
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS button_presses (
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    callback_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    user_name TEXT,
    label TEXT NOT NULL,
    data TEXT NOT NULL,
    date INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id, callback_id)
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS reactions (
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    user_name TEXT,
    emoji TEXT NOT NULL,
    date INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id, user_id)
  ) WITHOUT ROWID`,

  // Forum topic names, learned from the topic-created message Telegram attaches to every
  // message posted in a topic. Bot API offers no way to list topics.
  `CREATE TABLE IF NOT EXISTS topics (
    chat_id INTEGER NOT NULL,
    thread_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, thread_id)
  ) WITHOUT ROWID`,

  // The first message id of each chat on each UTC day. Message ids grow within
  // a chat, so this turns "since <date>" into a primary-key range and keeps
  // reads proportional to the window searched, not the whole chat. Written at
  // most once per chat per day.
  // The first message id of each chat on each UTC day. Message ids grow within
  // a chat, so this turns "since <date>" into a primary-key range and keeps
  // reads proportional to the window searched, not the whole chat. Written at
  // most once per chat per day.
  `CREATE TABLE IF NOT EXISTS day_marks (${DAY_MARKS_COLUMNS}
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS upload_nonces (
    nonce TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  ) WITHOUT ROWID`,

  // One row per sign-in that has refreshed at least once: which generation of
  // its refresh token is current. Written once per refresh, about daily.
  `CREATE TABLE IF NOT EXISTS refresh_sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    rotated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    client_name TEXT,
    created_at INTEGER
) WITHOUT ROWID`,

  // Memory: one Markdown document per user and chat, written by their
  // assistants. The private chat with the bot is the user's own id.
  `CREATE TABLE IF NOT EXISTS memory_docs (
    user_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT,
    PRIMARY KEY (user_id, chat_id)
  ) WITHOUT ROWID`,

  // What each document read before a change: for undo. A few per document.
  `CREATE TABLE IF NOT EXISTS memory_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    content_before TEXT,
    changed_at INTEGER NOT NULL,
    changed_by TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS memory_history_by_doc ON memory_history (user_id, chat_id, id)`,

  // The last notice about changes to a document, so changes in quick
  // succession edit one message instead of sending many.
  `CREATE TABLE IF NOT EXISTS memory_notices (
    user_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    client TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    first_history_id INTEGER NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, chat_id, client)
  ) WITHOUT ROWID`,

  // The user's Claude Code routine, started when they tag Claude in Telegram.
  // The API token is encrypted with a key derived from the bot token.
  `CREATE TABLE IF NOT EXISTS routines (
    user_id INTEGER PRIMARY KEY,
    trigger_id TEXT NOT NULL,
    token_enc TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    test_session TEXT,
    test_at INTEGER
  )`,

  // Chats where a tag starts the routine, and for whom: one user per chat,
  // whoever turned it on first. `others`: tags from other members count too.
  `CREATE TABLE IF NOT EXISTS claude_chats (
    chat_id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    others INTEGER NOT NULL DEFAULT 0,
    others_limit INTEGER NOT NULL DEFAULT 20,
    since INTEGER NOT NULL
  )`,

  // Each start, by the message that caused it: Telegram retries webhooks, and
  // a start is a billed session. Also counts other members' starts per hour,
  // and makes the chat's log of starts: who, when, the first words.
  `CREATE TABLE IF NOT EXISTS fires (
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    by_other INTEGER NOT NULL,
    status TEXT NOT NULL,
    session_id TEXT,
    at INTEGER NOT NULL,
    from_name TEXT,
    excerpt TEXT,
    album TEXT,
    PRIMARY KEY (chat_id, message_id)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS fires_by_user ON fires (user_id, at)`,

  // The user's relay: a machine signed in to Claude Code that passes messages
  // into cloud sessions (`claude -p --cloud`). Only a hash of its token is kept.
  `CREATE TABLE IF NOT EXISTS relays (
    user_id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER,
    login_failed_at INTEGER,
    offline_noticed_at INTEGER
  )`,

  // Messages for the relay to pass on, and answers to them. `origin` is who
  // stands behind the message by the bot's own records, never by the sender's word.
  `CREATE TABLE IF NOT EXISTS relay_jobs (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    target_session TEXT NOT NULL,
    body TEXT NOT NULL,
    origin TEXT NOT NULL,
    from_session TEXT,
    chat_id INTEGER,
    message_id INTEGER,
    thread_id INTEGER,
    status TEXT NOT NULL,
    error TEXT,
    wants_answer INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'reply',
    answer TEXT,
    answered_at INTEGER,
    created_at INTEGER NOT NULL,
    taken_at INTEGER
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS relay_jobs_by_user ON relay_jobs (user_id, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS relay_jobs_by_status ON relay_jobs (status, created_at)`,

  // A user's Telegram Business connection: the bot reads their private chats,
  // and acts in them only as far as `rights` (set by the user in Telegram) allow.
  `CREATE TABLE IF NOT EXISTS business_connections (
    user_id INTEGER PRIMARY KEY,
    connection_id TEXT NOT NULL UNIQUE,
    rights TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    connected_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  // Who each personal chat is with, for listings and resolving names.
  `CREATE TABLE IF NOT EXISTS personal_chats (
    account_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    title TEXT,
    username TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, chat_id)
  ) WITHOUT ROWID`,
];

/**
 * Steps bringing a database from the version before `target` up to it.
 *
 * `alter` statements run one by one and tolerate a racing isolate's
 * "duplicate column", and a table an older version never had: SCHEMA creates
 * it afterwards, already with the column. `rebuild` runs as one transaction
 * whose first statement claims the step in `meta`: a second isolate fails on
 * that claim and rolls back, so a table is never rebuilt twice.
 */
const UPGRADES: { target: number; alter?: string[]; rebuild?: string[] }[] = [
  { target: 2, alter: ["ALTER TABLE users ADD COLUMN connected_at INTEGER"] },
  {
    // account_id joins the primary keys, which SQLite can only do by copying the table.
    target: 4,
    rebuild: [
      `CREATE TABLE messages_v4 (${MESSAGES_COLUMNS}) WITHOUT ROWID`,
      `INSERT INTO messages_v4 (${V2_MESSAGE_COLUMNS}) SELECT ${V2_MESSAGE_COLUMNS} FROM messages`,
      "DROP TABLE messages",
      "ALTER TABLE messages_v4 RENAME TO messages",
      `CREATE TABLE day_marks_v4 (${DAY_MARKS_COLUMNS}) WITHOUT ROWID`,
      "INSERT INTO day_marks_v4 (chat_id, day, first_id) SELECT chat_id, day, first_id FROM day_marks",
      "DROP TABLE day_marks",
      "ALTER TABLE day_marks_v4 RENAME TO day_marks",
    ],
  },
  {
    target: 5,
    alter: [
      "ALTER TABLE messages ADD COLUMN via_bot TEXT",
      "ALTER TABLE messages ADD COLUMN as_chat INTEGER NOT NULL DEFAULT 0",
    ],
  },
  {
    target: 6,
    alter: [
      "ALTER TABLE refresh_sessions ADD COLUMN client_name TEXT",
      "ALTER TABLE refresh_sessions ADD COLUMN created_at INTEGER",
    ],
  },
  {
    target: 8,
    alter: [
      "ALTER TABLE messages ADD COLUMN session_id TEXT",
      "ALTER TABLE messages ADD COLUMN awaited_until INTEGER",
    ],
  },
  {
    target: 11,
    alter: [
      "ALTER TABLE routines ADD COLUMN test_session TEXT",
      "ALTER TABLE routines ADD COLUMN test_at INTEGER",
    ],
  },
  {
    target: 12,
    alter: ["ALTER TABLE claude_chats ADD COLUMN others_limit INTEGER NOT NULL DEFAULT 20"],
  },
  {
    target: 13,
    alter: [
      "ALTER TABLE fires ADD COLUMN from_name TEXT",
      "ALTER TABLE fires ADD COLUMN excerpt TEXT",
      "ALTER TABLE fires ADD COLUMN album TEXT",
      "ALTER TABLE messages ADD COLUMN album TEXT",
    ],
  },
  {
    target: 15,
    alter: ["ALTER TABLE relay_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'reply'"],
  },
];

const ready = new WeakMap<D1Database, Promise<void>>();

export function ensureSchema(db: D1Database): Promise<void> {
  let promise = ready.get(db);
  if (!promise) {
    promise = migrate(db);
    ready.set(db, promise);
    promise.catch(() => ready.delete(db));
  }
  return promise;
}

async function migrate(db: D1Database): Promise<void> {
  // Only a missing meta table means a fresh database. Any other failure must
  // stop here: taken for "fresh", it would stamp the latest version on old tables.
  const current = await db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .first<{ value: string }>()
    .catch((error: unknown) => {
      if (/no such table/i.test(String(error))) return null;
      throw error;
    });
  const version = current ? Number(current.value) : 0;
  if (version >= SCHEMA_VERSION) return;

  // A database made by an older version is brought up step by step.
  for (const step of UPGRADES) {
    if (version === 0 || version >= step.target) continue;
    for (const sql of step.alter ?? []) {
      await db
        .prepare(sql)
        .run()
        .catch((error: unknown) => {
          if (!/duplicate column|no such table/i.test(String(error))) throw error;
        });
    }
    if (step.rebuild) {
      await db
        .batch([
          db
            .prepare("INSERT INTO meta (key, value) VALUES (?, '1')")
            .bind(`upgrade_${step.target}`),
          ...step.rebuild.map((sql) => db.prepare(sql)),
        ])
        .catch(async (error: unknown) => {
          // Fine only if another isolate claimed this step: its claim commits with its rebuild.
          const claimed = await db
            .prepare("SELECT 1 FROM meta WHERE key = ?")
            .bind(`upgrade_${step.target}`)
            .first();
          if (!claimed) throw error;
        });
    }
  }

  await db.batch([
    ...SCHEMA.map((sql) => db.prepare(sql)),
    db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .bind(String(SCHEMA_VERSION)),
  ]);
}

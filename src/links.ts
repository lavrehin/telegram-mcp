/**
 * t.me links the model can hand to the user, so one tap opens the chat or
 * the exact message in Telegram.
 *
 * Bot API chat ids for supergroups are `-100` followed by the internal id;
 * `t.me/c/<internal>/<message>` opens a message there for any member, and
 * `t.me/<username>/<message>` does the same for public groups. Basic groups
 * and private chats (the bot's, or a user's personal ones) have no message
 * links at all — for those the best there is, is the chat itself.
 */

export interface LinkTarget {
  chat_id: number;
  type: string;
  username?: string | null;
}

function botLink(botUsername: string): string {
  return `https://t.me/${botUsername}`;
}

function internalId(chatId: number): string | null {
  const raw = String(chatId);
  return raw.startsWith("-100") ? raw.slice(4) : null;
}

/**
 * A link to the chat, or null when Telegram has none (a private basic group,
 * a personal chat with someone who has no username).
 */
export function chatLink(chat: LinkTarget, botUsername: string): string | null {
  if (chat.type === "private") return botLink(botUsername);
  if (chat.type === "personal") return chat.username ? `https://t.me/${chat.username}` : null;
  if (chat.username) return `https://t.me/${chat.username}`;
  return null;
}

export function messageLink(
  chat: LinkTarget,
  messageId: number,
  threadId: number | null | undefined,
  botUsername: string,
): string | null {
  if (chat.type === "private") return botLink(botUsername);
  // A user's personal chat: no message links, only the person's profile.
  if (chat.type === "personal") return chatLink(chat, botUsername);
  const topic = threadId ? `${threadId}/` : "";
  if (chat.username) return `https://t.me/${chat.username}/${topic}${messageId}`;
  const internal = internalId(chat.chat_id);
  return internal ? `https://t.me/c/${internal}/${topic}${messageId}` : null;
}

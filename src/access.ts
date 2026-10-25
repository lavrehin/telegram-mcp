/**
 * Who may read and write which chat.
 *
 * A user always has their own private chat with the bot. Personal chats —
 * the user's own conversations with other people — exist only while the user
 * has connected the bot to their account (Telegram Business), and only the
 * user sees them; what the bot may do there besides reading is whatever the
 * user allowed in Telegram's settings, checked on every call. Groups need a grant
 * — made when the user adds the bot, or by /connect — and a grant only ever
 * belongs to one user: two people on one group have two grants, and revoking
 * one leaves the other alone. Messages are stored once per chat regardless.
 *
 * A grant is not forever. People leave groups, and a bot that is not an admin
 * is never told. So a grant older than `REVALIDATE_SECONDS` is checked against
 * getChatMember before it is used, and dropped if the user is gone. That is at
 * most one Bot API call per group per user per interval.
 */

import { nowSeconds } from "./crypto";
import { formatTime } from "./format";
import { chatLink } from "./links";
import {
  BOT_ACCOUNT,
  type BusinessRow,
  type GrantRow,
  type GrantWithChat,
  type PersonalChatRow,
  type Scope,
  type Store,
} from "./store";
import { TelegramError, type TelegramApi } from "./telegram/api";
import { isMember, type BusinessBotRights, type ChatMember } from "./telegram/types";

const REVALIDATE_SECONDS = 60 * 60;

/** Telegram lets a business bot act in a chat only this long after the other side last wrote. */
export const PERSONAL_REPLY_WINDOW = 24 * 60 * 60;

export interface ChatView extends Scope {
  kind: "dm" | "group" | "personal";
  type: string;
  title: string;
  username: string | null;
  is_forum: boolean;
  /** `added_bot` or `connect`; absent for the DM. */
  source?: GrantRow["source"];
  link: string | null;
  /** For personal chats: the connection that shows them, and what the user allowed. */
  business?: { connection_id: string; rights: BusinessBotRights };
}

/** What a tool wants to do in a personal chat, and the right the user must have given for it. */
export type PersonalAction = "reply" | "read" | "delete";

const RIGHTS: Record<PersonalAction, { right: keyof BusinessBotRights; toggle: string }> = {
  reply: { right: "can_reply", toggle: "Reply to messages" },
  read: { right: "can_read_messages", toggle: "Mark messages as read" },
  delete: { right: "can_delete_sent_messages", toggle: "Delete sent messages" },
};

export function rightsOf(row: BusinessRow): BusinessBotRights {
  try {
    return JSON.parse(row.rights) as BusinessBotRights;
  } catch {
    return {};
  }
}

/** Where a Bot API call goes: the chat, and for a personal chat the connection it acts through. */
export function telegramChat(chat: ChatView): {
  chat_id: number;
  business_connection_id?: string;
} {
  return chat.business
    ? { chat_id: chat.chat_id, business_connection_id: chat.business.connection_id }
    : { chat_id: chat.chat_id };
}

/** A refusal the model should read and relay — not a crash. */
export class AccessError extends Error {}

/** Telegram says this user is not, or no longer, in the chat. */
function isGoneError(error: TelegramError): boolean {
  return /user not found|participant_id_invalid|member not found|user_not_participant/i.test(
    error.description,
  );
}

/** Telegram says the bot can no longer see the chat at all. */
export function isChatGoneError(error: TelegramError): boolean {
  return (
    error.code === 403 ||
    /chat not found|bot was kicked|bot is not a member|group chat was upgraded/i.test(
      error.description,
    )
  );
}

export class Access {
  constructor(
    private readonly store: Store,
    private readonly api: TelegramApi,
    readonly userId: number,
    private readonly botUsername: string,
  ) {}

  dm(): ChatView {
    return {
      kind: "dm",
      account_id: BOT_ACCOUNT,
      chat_id: this.userId,
      visible_from: 0,
      type: "private",
      title: "Private chat with the bot",
      username: null,
      is_forum: false,
      link: chatLink({ chat_id: this.userId, type: "private" }, this.botUsername),
    };
  }

  private view(grant: GrantWithChat): ChatView {
    return {
      kind: "group",
      account_id: BOT_ACCOUNT,
      chat_id: grant.chat_id,
      visible_from: grant.visible_from,
      type: grant.type,
      title: grant.title ?? grant.username ?? String(grant.chat_id),
      username: grant.username,
      is_forum: grant.is_forum === 1,
      source: grant.source,
      link: chatLink(grant, this.botUsername),
    };
  }

  /**
   * Check a grant against Telegram when it is due. Resolves to false when the
   * grant has been dropped. A Telegram outage keeps the grant: refusing the
   * user their own group over a hiccup is the worse failure.
   */
  private async revalidate(grant: GrantRow): Promise<boolean> {
    if (nowSeconds() - grant.verified_at < REVALIDATE_SECONDS) return true;

    let member: ChatMember;
    try {
      member = await this.api.call<ChatMember>("getChatMember", {
        chat_id: grant.chat_id,
        user_id: grant.user_id,
      });
    } catch (error) {
      if (!(error instanceof TelegramError)) return true;
      if (isChatGoneError(error)) {
        await this.store.deleteChat(grant.chat_id);
        return false;
      }
      if (isGoneError(error)) {
        await this.drop(grant.chat_id);
        return false;
      }
      return true;
    }

    if (!isMember(member)) {
      await this.drop(grant.chat_id);
      return false;
    }
    await this.store.touchGrant(grant.user_id, grant.chat_id);
    return true;
  }

  /** Remove this user's grant; the last grant on a chat takes the chat's history with it. */
  async drop(chatId: number): Promise<void> {
    await this.store.revokeGrant(this.userId, chatId);
  }

  async groups(): Promise<ChatView[]> {
    const grants = await this.store.listGrants(this.userId);
    const valid = await Promise.all(grants.map((grant) => this.revalidate(grant)));
    return grants.filter((_, index) => valid[index]).map((grant) => this.view(grant));
  }

  /** The user's personal chats, while their business connection is on. */
  async personal(): Promise<ChatView[]> {
    const connection = await this.store.getBusinessConnection(this.userId);
    if (!connection?.enabled) return [];
    const business = { connection_id: connection.connection_id, rights: rightsOf(connection) };
    const chats = await this.store.listPersonalChats(this.userId);
    return chats.map((chat) => this.personalView(chat, business));
  }

  private personalView(
    chat: PersonalChatRow,
    business: NonNullable<ChatView["business"]>,
  ): ChatView {
    const target = { chat_id: chat.chat_id, type: "personal", username: chat.username };
    return {
      kind: "personal",
      account_id: this.userId,
      chat_id: chat.chat_id,
      // Nothing from before the connection was ever delivered, so there is nothing to hide.
      visible_from: 0,
      type: "personal",
      title: chat.title ?? (chat.username ? `@${chat.username}` : String(chat.chat_id)),
      username: chat.username,
      is_forum: false,
      link: chatLink(target, this.botUsername),
      business,
    };
  }

  async all(): Promise<ChatView[]> {
    const [groups, personal] = await Promise.all([this.groups(), this.personal()]);
    return [this.dm(), ...groups, ...personal];
  }

  /**
   * Refuse, before anything reaches Telegram, what the user did not allow in a
   * personal chat: the right must be on in their Telegram settings, and the
   * other person must have written within the last 24 hours. Other chats pass.
   */
  async allow(chat: ChatView, action: PersonalAction): Promise<void> {
    if (chat.kind !== "personal") return;
    const { right, toggle } = RIGHTS[action];
    if (!chat.business?.rights[right]) {
      throw new AccessError(
        `The user has not allowed this in their personal chats: "${toggle}" is off for the bot in Telegram ` +
          "(Settings → Telegram Business → Chatbots). Nothing was done. Only the user can turn it on there; " +
          "do not look for another way.",
      );
    }
    if (action === "delete") return;
    const last = (await this.store.lastIncoming(chat))?.date ?? null;
    if (last === null || nowSeconds() - last > PERSONAL_REPLY_WINDOW) {
      throw new AccessError(
        `Telegram lets the bot act in ${JSON.stringify(chat.title)} only within 24 hours of their last message` +
          (last === null ? ", and none is stored." : ` (the last was ${formatTime(last)} UTC).`) +
          " Nothing was done.",
      );
    }
  }

  /**
   * Resolve what the model passed as `chat`: nothing or "me" for the DM, a
   * numeric id, an @username, or a title. Only chats this user may access
   * are candidates, so a guess can never reach someone else's group.
   */
  async resolve(arg: string | number | undefined | null): Promise<ChatView> {
    const raw = arg === undefined || arg === null ? "" : String(arg).trim();
    const lowered = raw.toLowerCase();
    if (!raw || ["me", "dm", "private", "self"].includes(lowered) || raw === String(this.userId)) {
      return this.dm();
    }

    // Group ids are negative and personal chats are with people, so an id names one chat at most.
    const [groups, personal] = await Promise.all([this.groups(), this.personal()]);
    const chats = [...groups, ...personal];
    const describe = () => {
      const named = (list: ChatView[]) =>
        list
          .slice(0, 30)
          .map((chat) => `${chat.chat_id} ${JSON.stringify(chat.title)}`)
          .join(", ") + (list.length > 30 ? ` and ${list.length - 30} more (list_chats)` : "");
      const parts = ['"me" (the private chat with the bot)'];
      if (groups.length) parts.push(`groups: ${named(groups)}`);
      if (personal.length) parts.push(`personal chats: ${named(personal)}`);
      if (chats.length) return `Available: ${parts.join("; ")}.`;
      return (
        'Only "me" (the private chat) is available: the user has connected no groups and no personal ' +
        "chats. They can add the bot to a group, or send /connect there."
      );
    };

    if (/^-?\d+$/.test(raw)) {
      const found = chats.find((chat) => chat.chat_id === Number(raw));
      if (found) return found;
      throw new AccessError(`Chat ${raw} is not one this user has connected. ${describe()}`);
    }

    const handle = lowered.replace(/^@/, "").replace(/^https?:\/\/t\.me\//, "");
    const byUsername = chats.find((chat) => chat.username?.toLowerCase() === handle);
    if (byUsername) return byUsername;

    const byTitle = chats.filter((chat) => chat.title.toLowerCase() === lowered);
    if (byTitle.length === 1) return byTitle[0];

    const partial = chats.filter((chat) => chat.title.toLowerCase().includes(lowered));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1 || byTitle.length > 1) {
      throw new AccessError(`"${raw}" matches several chats; pass the numeric id. ${describe()}`);
    }
    throw new AccessError(`No connected chat matches "${raw}". ${describe()}`);
  }
}

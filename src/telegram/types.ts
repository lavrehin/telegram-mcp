/**
 * The slice of Bot API types this connector reads. Hand-written rather than
 * pulled from a package: Telegram adds fields all the time, and every field
 * here is optional unless the API guarantees it, so a new one never breaks us.
 */

export interface User {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  can_read_all_group_messages?: boolean;
}

type ChatType = "private" | "group" | "supergroup" | "channel";

interface Chat {
  id: number;
  type: ChatType;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: boolean;
}

/** getChat's answer. `has_visible_history` is only filled in for administrators. */
export interface ChatFullInfo extends Chat {
  has_visible_history?: boolean;
}

export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: User;
  url?: string;
}

interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface FileBase {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface MessageOrigin {
  type: "user" | "hidden_user" | "chat" | "channel";
  sender_user?: User;
  sender_user_name?: string;
  sender_chat?: Chat;
  chat?: Chat;
}

interface ChatShared {
  request_id: number;
  chat_id: number;
  title?: string;
  username?: string;
}

export interface Message {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: User;
  sender_chat?: Chat;
  date: number;
  edit_date?: number;
  chat: Chat;
  forward_origin?: MessageOrigin;
  /** Sent through an inline bot: the sender picked its result, did not write it. */
  via_bot?: User;
  /** Service message: a member left or was removed. */
  left_chat_member?: User;
  reply_to_message?: Message;
  /** Shared by the photos and files sent together as one album. */
  media_group_id?: string;
  /** The part of the replied-to message the sender highlighted. */
  quote?: { text: string };
  /** A reply to a message in another chat. */
  external_reply?: { origin?: MessageOrigin; chat?: Chat; message_id?: number };
  text?: string;
  entities?: MessageEntity[];
  caption?: string;
  caption_entities?: MessageEntity[];
  document?: FileBase;
  photo?: PhotoSize[];
  video?: FileBase;
  audio?: FileBase & { title?: string; performer?: string };
  voice?: FileBase;
  video_note?: FileBase;
  animation?: FileBase;
  sticker?: FileBase & { emoji?: string };
  location?: { latitude: number; longitude: number };
  contact?: { phone_number: string; first_name: string; last_name?: string };
  poll?: { question: string; options: { text: string }[] };
  chat_shared?: ChatShared;
  forum_topic_created?: { name: string };
  forum_topic_edited?: { name?: string };
  migrate_to_chat_id?: number;
  new_chat_title?: string;
  reply_markup?: InlineKeyboardMarkup;
  /** Set on messages of a chat managed through a business connection. */
  business_connection_id?: string;
  /** On the account owner's outgoing messages: the bot that sent it on their behalf. */
  sender_business_bot?: User;
}

/** What the account owner let the bot do, in Telegram's settings. Absent fields are false. */
export interface BusinessBotRights {
  can_reply?: boolean;
  can_read_messages?: boolean;
  can_delete_sent_messages?: boolean;
  can_delete_all_messages?: boolean;
}

export interface BusinessConnection {
  id: string;
  user: User;
  user_chat_id: number;
  date: number;
  rights?: BusinessBotRights;
  is_enabled: boolean;
}

export interface BusinessMessagesDeleted {
  business_connection_id: string;
  chat: Chat;
  message_ids: number[];
}

type ChatMemberStatus = "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";

export interface ChatMember {
  status: ChatMemberStatus;
  user: User;
  /** Only for "restricted": whether they are still in the chat. */
  is_member?: boolean;
}

export interface ChatMemberUpdated {
  chat: Chat;
  from: User;
  date: number;
  old_chat_member: ChatMember;
  new_chat_member: ChatMember;
}

export interface CallbackQuery {
  id: string;
  from: User;
  message?: Message;
  data?: string;
}

interface ReactionType {
  type: "emoji" | "custom_emoji" | "paid";
  emoji?: string;
}

export interface MessageReactionUpdated {
  chat: Chat;
  message_id: number;
  user?: User;
  date: number;
  new_reaction: ReactionType[];
}

export interface Update {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  my_chat_member?: ChatMemberUpdated;
  chat_member?: ChatMemberUpdated;
  callback_query?: CallbackQuery;
  message_reaction?: MessageReactionUpdated;
  business_connection?: BusinessConnection;
  business_message?: Message;
  edited_business_message?: Message;
  deleted_business_messages?: BusinessMessagesDeleted;
}

interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface WebhookInfo {
  url: string;
  allowed_updates?: string[];
  pending_update_count: number;
  last_error_message?: string;
}

export function isMember(member: ChatMember): boolean {
  if (member.status === "left" || member.status === "kicked") return false;
  if (member.status === "restricted") return member.is_member !== false;
  return true;
}

export function displayName(user: Pick<User, "first_name" | "last_name">): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

/**
 * Setting up the user's routine from the private chat, and its test start.
 *
 * The routine's token arrives as an ordinary message. Such a message — or
 * anything else that looks like an Anthropic key — never reaches storage:
 * the webhook hands it here first, and it is deleted from the chat.
 */

import { isAllowed } from "../env";
import { fire, firePayload, loadRoutine, parseRoutine, saveRoutine } from "../routine";
import type { Message, User } from "../telegram/types";
import { hasConnected, type BotContext, type WebhookReply } from "./context";
import { texts } from "./texts";

function say(ctx: BotContext, chatId: number, text: string): Promise<unknown> {
  return ctx.api
    .call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    })
    .catch(() => undefined);
}

/**
 * When each user's last test start went out, in this isolate. Every start is
 * a billed cloud session, and a retried webhook or a double tap must not make
 * two; this costs no write, and a different isolate is rare enough.
 */
const lastTest = new Map<number, number>();
const TEST_COOLDOWN_MS = 60_000;

export function resetTestStarts(): void {
  lastTest.clear();
}

/** Start the routine once, as a check: the session answers "ok" in the private chat. */
export async function testRoutine(ctx: BotContext, user: User, messageId: number): Promise<void> {
  const t = texts(user.language_code);
  const routine = await loadRoutine(ctx.store, ctx.config.secretKey, user.id);
  if (typeof routine === "string") {
    await say(ctx, user.id, t.fireFailed(routine));
    return;
  }
  const last = lastTest.get(user.id);
  if (last !== undefined && Date.now() - last < TEST_COOLDOWN_MS) {
    await say(ctx, user.id, t.testTooSoon);
    return;
  }
  lastTest.set(user.id, Date.now());
  const result = await fire(
    routine.triggerId,
    routine.token,
    firePayload({ chat: user.id, message: messageId, by: "test" }),
  );
  if (result.ok) {
    await ctx.store.setRoutineTest(user.id, result.sessionId);
    await say(ctx, user.id, t.testStarted(result.sessionUrl));
    return;
  }
  lastTest.delete(user.id); // Nothing started: trying again at once is fine.
  console.error(
    JSON.stringify({ event: "routine_fire_failed", user: user.id, detail: result.detail }),
  );
  const minutes = result.retryAfter ? Math.ceil(result.retryAfter / 60) : undefined;
  await say(ctx, user.id, t.fireFailed(result.reason, minutes));
}

/**
 * A private message that holds a key: deleted, never stored. If it carries a
 * trigger id and a token, it sets the user's routine, followed by a test start.
 */
export async function handleSecret(
  ctx: BotContext,
  message: Message & { from: User },
): Promise<WebhookReply | null> {
  const user = message.from;
  const t = texts(user.language_code);
  const deleted = await ctx.api
    .call("deleteMessage", { chat_id: message.chat.id, message_id: message.message_id })
    .then(() => true)
    .catch(() => false);
  // If it stays in the chat, the key is exposed there: the user has to know.
  const after = deleted ? "" : `\n\n${t.deleteYourself}`;
  const routine = parseRoutine(message.text ?? message.caption ?? "");
  if (!routine || !isAllowed(ctx.config, user.id) || !(await hasConnected(ctx, user.id))) {
    await say(ctx, message.chat.id, t.secretDropped(deleted) + after);
    return null;
  }
  const first = !(await ctx.store.getRoutine(user.id));
  try {
    await saveRoutine(ctx.store, ctx.config.secretKey, user.id, routine);
  } catch (error) {
    console.error(
      JSON.stringify({ event: "routine_save_failed", user: user.id, error: String(error) }),
    );
    await say(ctx, message.chat.id, t.routineNotSaved + after);
    return null;
  }
  // Answering in the private chat comes on with the first routine; groups are turned on one by one.
  if (first) await ctx.store.claimClaudeChat(user.id, user.id);
  await say(ctx, message.chat.id, t.routineSaved(routine.triggerId, deleted) + after);
  await testRoutine(ctx, user, message.message_id);
  return null;
}

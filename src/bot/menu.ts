/**
 * The bot's menu in the private chat: one message whose inline buttons swap
 * the screen in place. `callback_data` is `m:<screen>` or `m:<screen>:<chat id>`:
 *
 *   m:main        what this is, and the user's Telegram ID
 *   m:groups      connected groups, a button each
 *   m:g:<id>      one group: what the assistant sees there, revoke
 *   m:rv:<id>     revoke that group, back to the list
 *   m:mem         memory: the chats that have one
 *   m:mv:<id>     one chat's memory (sent as a file when long)
 *   m:md:<id>     delete it: asks first; m:mdy:<id> does it
 *   m:mwipe       erase all memory: asks first; m:mwipey does it
 *   m:si          sign-ins, a sign-out button each
 *   m:sx:<id>     sign that one out
 *   m:out         sign out everywhere: asks first
 *   m:outyes      …and does it
 *   m:add         how to connect a group
 *   m:personal    personal chats through Telegram Business
 *   m:help        how it works, retention, commands
 *   m:cl          Claude on tag: the routine, if set
 *   m:clh         how to set the routine up; m:clp sends its prompt
 *   m:clset       asks for the trigger and token
 *   m:cltest      starts the routine once, as a check
 *   m:cldel       remove the routine: asks first; m:cldely does it
 *   m:cldm        Claude in the private chat: on or off
 *   m:rl          the relay that carries messages to sessions; m:rlnew sends a new
 *                 install command (new token), m:rloff turns it off
 *   m:gc:<id>     Claude in that group: on (taking it over from a holder who left) or off
 *   m:go:<id>     other members too: asks first; m:goy:<id> turns it on
 *   m:gl:<id>     their hourly limit: steps through 5, 10, 20, 50
 *   m:gs:<id>     the log of starts there
 *
 * Every press is checked again: anyone can send any callback_data.
 */

import { nowSeconds } from "../crypto";
import { formatTime } from "../format";
import { isAllowed } from "../env";
import { fallBack, relayState, relayToken, tokenHash } from "../relay";
import { routinePrompt, tokenOf } from "../routine";
import { memoryTitle } from "../tools/memory";
import { TelegramError } from "../telegram/api";
import type { CallbackQuery, InlineKeyboardMarkup, User } from "../telegram/types";
import { hasConnected, type BotContext, type WebhookReply } from "./context";
import { testRoutine } from "./routine";
import { holderName, stillMember } from "./triggers";
import { escapeHtml, formatDate, texts } from "./texts";

export interface Screen {
  text: string;
  reply_markup: InlineKeyboardMarkup;
}

const button = (text: string, screen: string) => ({ text, callback_data: `m:${screen}` });

/** The link that opens Telegram's own group picker to add the bot. */
export function addToGroupUrl(ctx: BotContext): string {
  return `https://t.me/${ctx.bot.username}?startgroup=connect`;
}

export async function mainScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  if (!(await hasConnected(ctx, user.id))) {
    return {
      text: `${t.menuIntro(user.id)}\n\n${t.menuNotConnected}`,
      reply_markup: { inline_keyboard: [[button(t.buttonHelp, "help")]] },
    };
  }
  return {
    text: t.menuIntro(user.id),
    reply_markup: {
      inline_keyboard: [
        [button(t.buttonGroups, "groups"), button(t.buttonAdd, "add")],
        [button(t.buttonMemory, "mem"), button(t.buttonSignIns, "si")],
        [button(t.buttonRoutine, "cl"), button(t.buttonPersonal, "personal")],
        [button(t.buttonHelp, "help")],
      ],
    },
  };
}

async function groupsScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  const back = [button(t.buttonBack, "main")];
  const grants = await ctx.store.listGrants(user.id);
  const claude = grants.length
    ? await ctx.store.claudeChatsOf(user.id)
    : new Map<number, boolean>();
  // 🤖 Claude answers there for this user; ⚠️ for the other members too.
  const mark = (chatId: number) =>
    claude.has(chatId) ? (claude.get(chatId) ? "🤖⚠️ " : "🤖 ") : "";
  if (!grants.length) {
    return {
      text: t.noGroupsMenu,
      reply_markup: { inline_keyboard: [[button(t.buttonAdd, "add")], back] },
    };
  }
  const lines = grants.map((grant) =>
    t.groupLine({
      mark: mark(grant.chat_id),
      title: grant.title ?? String(grant.chat_id),
      full: grant.visible_from === 0,
      since: formatDate(grant.visible_from),
    }),
  );
  return {
    text: [t.groupsHeader, ...lines].join("\n"),
    reply_markup: {
      inline_keyboard: [
        ...grants.map((grant) => [
          button(
            mark(grant.chat_id) +
              Array.from(grant.title ?? String(grant.chat_id))
                .slice(0, 60)
                .join(""),
            `g:${grant.chat_id}`,
          ),
        ]),
        back,
      ],
    },
  };
}

/** The title of a chat whose memory the user may see, or null when it is not theirs. */
async function memoryChatTitle(
  ctx: BotContext,
  user: User,
  chatId: number,
): Promise<string | null> {
  const t = texts(user.language_code);
  if (chatId === user.id) return t.memoryOfMe;
  const grant = (await ctx.store.listGrants(user.id)).find((g) => g.chat_id === chatId);
  return grant ? memoryTitle({ kind: "group", title: grant.title }, t.memoryOfMe) : null;
}

async function memoryListScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  const docs = await ctx.store.listMemory(user.id);
  const titled = await Promise.all(
    docs.map(async (doc) => ({ ...doc, title: await memoryChatTitle(ctx, user, doc.chat_id) })),
  );
  const shown = titled.filter((doc) => doc.title !== null);
  return {
    text: t.memoryListScreen(
      shown.map((doc) =>
        t.memoryLine({ chat: doc.title!, size: doc.length, date: formatDate(doc.updated_at) }),
      ),
    ),
    reply_markup: {
      inline_keyboard: [
        ...shown.map((doc) => [
          button(Array.from(doc.title!).slice(0, 60).join(""), `mv:${doc.chat_id}`),
        ]),
        ...(shown.length ? [[button(t.buttonWipe, "mwipe")]] : []),
        [button(t.buttonBack, "main")],
      ],
    },
  };
}

/** Memory whose screen would be longer than this goes as a file: a message holds 4096. */
const MEMORY_INLINE = 3900;

async function memoryScreen(
  ctx: BotContext,
  user: User,
  chatId: number,
  title: string,
): Promise<Screen> {
  const t = texts(user.language_code);
  const doc = await ctx.store.getMemory(user.id, chatId);
  const back = [button(t.buttonBack, "mem")];
  if (!doc) return { text: t.memoryNone(title), reply_markup: { inline_keyboard: [back] } };
  let shown = t.memoryDoc({ chat: title, content: doc.content });
  if (shown.length > MEMORY_INLINE) {
    await ctx.api.upload(
      "sendDocument",
      { chat_id: user.id, disable_notification: true },
      "document",
      new Blob([doc.content], { type: "text/markdown" }),
      `memory-${chatId}.md`,
    );
    shown = t.memoryAsFile(title);
  }
  return {
    text: shown,
    reply_markup: { inline_keyboard: [[button(t.buttonDelete, `md:${chatId}`)], back] },
  };
}

async function signInsScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  const signIns = await ctx.store.listSignIns(user.id);
  const name = (client: string | null) => client ?? t.unknownClient;
  const lines = signIns.map((row) =>
    t.signInLine({
      client: name(row.client_name),
      since: row.created_at ? formatDate(row.created_at) : null,
      seen: formatDate(row.rotated_at),
    }),
  );
  return {
    text: t.signInsScreen(lines),
    reply_markup: {
      inline_keyboard: [
        ...signIns.map((row) => [
          button(
            Array.from(t.signOutButton(name(row.client_name)))
              .slice(0, 60)
              .join(""),
            `sx:${row.id}`,
          ),
        ]),
        ...(signIns.length ? [[button(t.buttonSignOutAll, "out")]] : []),
        [button(t.buttonBack, "main")],
      ],
    },
  };
}

async function routineScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  const row = await ctx.store.getRoutine(user.id);
  const state = !row
    ? "none"
    : (await tokenOf(ctx.config.secretKey, row)) === null
      ? "broken"
      : "set";
  const here = (await ctx.store.getClaudeChat(user.id))?.user_id === user.id;
  let test = "";
  // A day on, the test says nothing new — and its answer may be purged with the messages.
  if (state === "set" && row?.test_session && row.test_at && nowSeconds() - row.test_at < 86_400) {
    const answered = await ctx.store.sessionSpokeIn(user.id, row.test_session, row.test_at);
    const at = formatDate(row.test_at);
    test = `\n\n${answered ? t.testPassed(at) : t.testWaiting(at)}`;
  }
  return {
    text:
      t.routineScreen({
        state,
        trigger: row?.trigger_id,
        since: row ? formatDate(row.updated_at) : undefined,
      }) +
      test +
      (state === "set" ? `\n\n${t.claudeHereHint}` : ""),
    reply_markup: {
      inline_keyboard: [
        [button(t.buttonGuide, "clh"), button(t.buttonSetRoutine, "clset")],
        ...(state === "set"
          ? [[button(t.claudeHere(here), "cldm"), button(t.buttonTestRoutine, "cltest")]]
          : []),
        ...(state === "set"
          ? [[button(t.buttonRelay(relayState(await ctx.store.getRelay(user.id))), "rl")]]
          : []),
        ...(row ? [[button(t.buttonDeleteRoutine, "cldel")]] : []),
        [button(t.buttonBack, "main")],
      ],
    },
  };
}

async function relayScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  const row = await ctx.store.getRelay(user.id);
  return {
    text: t.relayScreen({
      state: relayState(row),
      seen: row?.last_seen ? formatDate(row.last_seen) : null,
    }),
    reply_markup: {
      inline_keyboard: [
        [button(t.buttonRelayInstall, "rlnew")],
        ...(row ? [[button(t.buttonRelayOff, "rloff")]] : []),
        [button(t.buttonBack, "cl")],
      ],
    },
  };
}

function guideScreen(user: User): Screen {
  const t = texts(user.language_code);
  return {
    text: t.routineGuide,
    reply_markup: {
      inline_keyboard: [
        [{ text: t.buttonOpenRoutines, url: "https://claude.ai/code/routines" }],
        [button(t.buttonSendPrompt, "clp"), button(t.buttonSetRoutine, "clset")],
        [button(t.buttonBack, "cl")],
      ],
    },
  };
}

/** What "Others too" may cost per hour in one chat; a press steps to the next. */
const OTHERS_LIMITS = [5, 10, 20, 50];

async function groupScreen(
  ctx: BotContext,
  user: User,
  grant: { chat_id: number; title: string | null; visible_from: number },
): Promise<Screen> {
  const t = texts(user.language_code);
  const chatId = grant.chat_id;
  const claim = await ctx.store.getClaudeChat(chatId);
  const on = claim?.user_id === user.id;
  const heldBy = claim && !on ? await holderName(ctx, claim.user_id) : null;
  // With privacy mode on, a group where the bot is no admin shows it only mentions and replies.
  const blind = on && !ctx.bot.canReadAll && !(await ctx.store.getChat(chatId))?.bot_is_admin;
  return {
    text:
      t.groupScreen({
        title: grant.title ?? String(chatId),
        full: grant.visible_from === 0,
        since: formatDate(grant.visible_from),
      }) +
      t.groupClaude({
        on,
        others: on && claim.others === 1,
        limit: claim?.others_limit ?? 0,
        heldBy,
      }) +
      (blind ? `\n${t.privacyHint}` : ""),
    reply_markup: {
      inline_keyboard: [
        [button(t.claudeToggle(on), `gc:${chatId}`)],
        ...(on ? [[button(t.othersToggle(claim.others === 1), `go:${chatId}`)]] : []),
        ...(on && claim.others === 1
          ? [[button(t.othersLimitButton(claim.others_limit), `gl:${chatId}`)]]
          : []),
        ...(on ? [[button(t.startsButton, `gs:${chatId}`)]] : []),
        [button(t.buttonChatMemory, `mv:${chatId}`)],
        [button(t.buttonRevoke, `rv:${chatId}`)],
        [button(t.buttonBack, "groups")],
      ],
    },
  };
}

const STARTS_SHOWN = 15;
const STARTS_MARK = {
  pending: "⏳",
  started: "▶️",
  relayed: "↪️",
  joined: "➕",
  failed: "⚠️",
} as const;

/** The holder's latest starts in a group: who, when, the first words, the session. */
async function startsScreen(
  ctx: BotContext,
  user: User,
  chatId: number,
  title: string,
): Promise<Screen> {
  const t = texts(user.language_code);
  const { fires, limited } = await ctx.store.firesIn(
    user.id,
    chatId,
    STARTS_SHOWN,
    nowSeconds() - 86_400,
  );
  const lines = fires.map(
    (fire) =>
      `${STARTS_MARK[fire.status]} ${formatTime(fire.at).slice(5)} ${escapeHtml(fire.from_name ?? "?")}` +
      (fire.excerpt ? `: «${escapeHtml(fire.excerpt)}»` : "") +
      (fire.session_id
        ? ` — <a href="https://claude.ai/code/${escapeHtml(fire.session_id)}">${t.startsSession}</a>`
        : ""),
  );
  return {
    text:
      (lines.length ? t.startsScreen(title, lines) : t.startsEmpty(title)) +
      (limited ? `\n\n${t.startsLimited(limited)}` : ""),
    reply_markup: { inline_keyboard: [[button(t.buttonBack, `g:${chatId}`)]] },
  };
}

/**
 * Turn Claude on or off in a group. Whoever turned it on first holds the
 * chat; a holder Telegram says has left loses it to whoever asks next.
 */
async function toggleClaude(
  ctx: BotContext,
  user: User,
  chatId: number,
  claim: { user_id: number } | null,
): Promise<string | undefined> {
  const t = texts(user.language_code);
  if (claim?.user_id === user.id) {
    await ctx.store.releaseClaudeChat(user.id, chatId);
    return undefined;
  }
  if (!(await ctx.store.getRoutine(user.id))) return t.routineFirst;
  if (claim) {
    if ((await stillMember(ctx, chatId, claim.user_id)) !== false) return t.chatHeld;
    await ctx.store.revokeGrant(claim.user_id, chatId);
  }
  return (await ctx.store.claimClaudeChat(user.id, chatId)) ? undefined : t.chatHeld;
}

function staticScreen(text: string, back: string, user: User): Screen {
  return {
    text,
    reply_markup: { inline_keyboard: [[button(texts(user.language_code).buttonBack, back)]] },
  };
}

/** The screen for `name`, and a short note to show with it. */
async function render(
  ctx: BotContext,
  user: User,
  name: string,
): Promise<Screen & { note?: string }> {
  const t = texts(user.language_code);
  const connected = await hasConnected(ctx, user.id);
  if (name === "help") {
    return staticScreen(
      t.helpScreen({ retention: ctx.config.retentionDays, privacyOn: !ctx.bot.canReadAll }),
      "main",
      user,
    );
  }
  if (!connected) return mainScreen(ctx, user);

  if (name === "groups") return groupsScreen(ctx, user);
  if (name === "si") return signInsScreen(ctx, user);
  if (name === "mem") return memoryListScreen(ctx, user);
  if (name === "mwipe") {
    return {
      text: t.confirmWipe,
      reply_markup: {
        inline_keyboard: [[button(t.buttonConfirmWipe, "mwipey")], [button(t.buttonCancel, "mem")]],
      },
    };
  }
  if (name === "mwipey") {
    await ctx.store.wipeMemory(user.id);
    return { ...(await memoryListScreen(ctx, user)), note: t.memoryWiped };
  }
  const memory = /^(mv|md|mdy):(-?\d+)$/.exec(name);
  if (memory) {
    const chatId = Number(memory[2]);
    const title = await memoryChatTitle(ctx, user, chatId);
    if (title === null) return { ...(await memoryListScreen(ctx, user)), note: t.menuGone };
    if (memory[1] === "md") {
      return {
        text: t.confirmDeleteMemory(title),
        reply_markup: {
          inline_keyboard: [
            [button(t.buttonConfirmDelete, `mdy:${chatId}`)],
            [button(t.buttonCancel, `mv:${chatId}`)],
          ],
        },
      };
    }
    if (memory[1] === "mdy") {
      await ctx.store.deleteMemory(user.id, chatId);
      return { ...(await memoryListScreen(ctx, user)), note: t.memoryDeleted };
    }
    return memoryScreen(ctx, user, chatId, title);
  }
  if (name === "out") {
    return {
      text: t.confirmSignOutAll,
      reply_markup: {
        inline_keyboard: [
          [button(t.buttonConfirmSignOut, "outyes")],
          [button(t.buttonCancel, "si")],
        ],
      },
    };
  }
  if (name === "outyes") {
    await ctx.store.bumpTokenVersion(user.id);
    return { ...(await signInsScreen(ctx, user)), note: t.disconnected };
  }
  // Ids are 16 characters, or 43 for sign-ins from before rotation (a token hash).
  const signOut = /^sx:([\w-]{1,43})$/.exec(name);
  if (signOut) {
    const done = await ctx.store.revokeSignIn(user.id, signOut[1]);
    return {
      ...(await signInsScreen(ctx, user)),
      note: done ? t.signedOut : t.alreadySignedOut,
    };
  }
  if (name === "personal") return staticScreen(t.personalScreen, "main", user);
  if (name === "cl") return routineScreen(ctx, user);
  if (name === "clh") return guideScreen(user);
  if (name === "clp") {
    await ctx.api.call("sendMessage", {
      chat_id: user.id,
      text: `${t.routinePromptIntro}\n<pre>${escapeHtml(routinePrompt(user.username ?? null))}</pre>`,
      parse_mode: "HTML",
    });
    return { ...guideScreen(user), note: t.promptSent };
  }
  if (name === "clset") {
    await ctx.api.call("sendMessage", {
      chat_id: user.id,
      text: t.setRoutineAsk,
      parse_mode: "HTML",
      reply_markup: { force_reply: true, input_field_placeholder: "trig_… sk-ant-oat01-…" },
    });
    return { ...(await routineScreen(ctx, user)), note: t.setRoutineNote };
  }
  if (name === "cldm") {
    const claim = await ctx.store.getClaudeChat(user.id);
    if (claim) await ctx.store.releaseClaudeChat(user.id, user.id);
    else if (await ctx.store.getRoutine(user.id)) await ctx.store.claimClaudeChat(user.id, user.id);
    return routineScreen(ctx, user);
  }
  if (name === "rl") return relayScreen(ctx, user);
  if (name === "rlnew") {
    const token = relayToken();
    await ctx.store.setRelay(user.id, await tokenHash(token));
    await ctx.api.call("sendMessage", {
      chat_id: user.id,
      text: t.relayInstall(`curl -fsSL ${ctx.origin}/relay/install.sh | RELAY_TOKEN=${token} bash`),
      parse_mode: "HTML",
    });
    return relayScreen(ctx, user);
  }
  if (name === "rloff") {
    // Replies it had not passed on yet start sessions instead of getting lost.
    for (const job of await ctx.store.deleteRelay(user.id)) await fallBack(ctx, job, "failed");
    return { ...(await relayScreen(ctx, user)), note: t.relayOff };
  }
  if (name === "cltest") {
    await testRoutine(ctx, user, 0);
    return routineScreen(ctx, user);
  }
  if (name === "cldel") {
    return {
      text: t.confirmDeleteRoutine,
      reply_markup: {
        inline_keyboard: [
          [button(t.buttonConfirmRemove, "cldely")],
          [button(t.buttonCancel, "cl")],
        ],
      },
    };
  }
  if (name === "cldely") {
    await ctx.store.deleteRoutine(user.id);
    // Nothing would start in them any more, and others could not turn Claude on there.
    await ctx.store.dropClaudeChats(user.id);
    return { ...(await routineScreen(ctx, user)), note: t.routineDeleted };
  }
  if (name === "add") {
    return {
      text: t.addScreen(ctx.bot.username),
      reply_markup: {
        inline_keyboard: [
          [{ text: t.buttonAddToGroup, url: addToGroupUrl(ctx) }],
          [button(t.buttonBack, "main")],
        ],
      },
    };
  }

  const group = /^(g|rv|gc|go|goy|gl|gs):(-?\d+)$/.exec(name);
  if (group) {
    const chatId = Number(group[2]);
    const grant = (await ctx.store.listGrants(user.id)).find((g) => g.chat_id === chatId);
    // Gone already (left, or revoked from /groups): the list, not a stale screen.
    if (!grant) return { ...(await groupsScreen(ctx, user)), note: t.menuGone };
    const title = grant.title ?? String(grant.chat_id);
    if (group[1] === "rv") {
      await ctx.store.revokeGrant(user.id, chatId);
      return { ...(await groupsScreen(ctx, user)), note: t.revoked };
    }
    let note: string | undefined;
    const claim = await ctx.store.getClaudeChat(chatId);
    const mine = claim?.user_id === user.id;
    if (group[1] === "gs" && mine) return startsScreen(ctx, user, chatId, title);
    if (group[1] === "gc") note = await toggleClaude(ctx, user, chatId, claim);
    if (group[1] === "go" && mine) {
      if (!claim.others) {
        return {
          text: t.othersWarning(title),
          reply_markup: {
            inline_keyboard: [
              [button(t.buttonTurnOn, `goy:${chatId}`)],
              [button(t.buttonCancel, `g:${chatId}`)],
            ],
          },
        };
      }
      await ctx.store.setClaudeOthers(user.id, chatId, false);
    }
    if (group[1] === "goy" && mine) await ctx.store.setClaudeOthers(user.id, chatId, true);
    if (group[1] === "gl" && mine) {
      const next =
        OTHERS_LIMITS[(OTHERS_LIMITS.indexOf(claim.others_limit) + 1) % OTHERS_LIMITS.length];
      await ctx.store.setClaudeOthersLimit(user.id, chatId, next);
    }
    return { ...(await groupScreen(ctx, user, grant)), note };
  }
  return mainScreen(ctx, user);
}

/**
 * Undo from a memory notice: `mu:<first>:<last>` covers the changes from
 * history entry `first` to `last`; `mu!:<first>` confirms dropping what came
 * after. Undoing is a change of its own, kept in history like any other, but
 * it sends no notice: the user made it.
 */
export async function handleMemoryUndo(
  ctx: BotContext,
  query: CallbackQuery,
  first: number,
  last: number | null,
): Promise<WebhookReply> {
  const t = texts(query.from.language_code);
  const answer = (text: string): WebhookReply => ({
    method: "answerCallbackQuery",
    callback_query_id: query.id,
    text,
  });
  const message = query.message;
  if (!message || message.chat.id !== query.from.id || !isAllowed(ctx.config, query.from.id)) {
    return answer(t.alreadyAnswered);
  }
  const change = await ctx.store.getMemoryChange(query.from.id, first);
  if (!change) return answer(t.undoGone);

  const edit = (text: string, reply_markup: object) =>
    ctx.api
      .call("editMessageText", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        text,
        parse_mode: "HTML",
        reply_markup,
      })
      .catch(() => undefined);

  if (last !== null) {
    const later = await ctx.store.memoryChangesAfter(query.from.id, change.chat_id, last);
    if (later > 0) {
      await edit(`${message.text ? escapeHtml(message.text) : ""}\n\n${t.undoConfirm(later)}`, {
        inline_keyboard: [[{ text: t.buttonUndoAnyway, callback_data: `mu!:${first}` }]],
      });
      return answer(t.undoConfirm(later));
    }
  }
  await ctx.store.writeMemory(query.from.id, change.chat_id, change.content_before, null);
  await ctx.store.dropMemoryNotice(query.from.id, message.message_id);
  await edit(`${message.text ? escapeHtml(message.text) : ""}\n\n↩ ${t.undone}`, {
    inline_keyboard: [],
  });
  return answer(t.undone);
}

/** A press on a menu button: swap the screen in place, or send it anew if that fails. */
export async function handleMenu(
  ctx: BotContext,
  query: CallbackQuery,
  name: string,
): Promise<WebhookReply> {
  const t = texts(query.from.language_code);
  const answer = (text?: string): WebhookReply => ({
    method: "answerCallbackQuery",
    callback_query_id: query.id,
    ...(text ? { text } : {}),
  });
  const message = query.message;
  if (!message || message.chat.type !== "private" || message.chat.id !== query.from.id) {
    return answer(t.alreadyAnswered);
  }
  if (!isAllowed(ctx.config, query.from.id)) {
    return answer(t.notAllowed(query.from.id).replace(/<[^>]+>/g, ""));
  }

  const screen = await render(ctx, query.from, name);

  const body = {
    text: screen.text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: screen.reply_markup,
  };
  try {
    await ctx.api.call("editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      ...body,
    });
  } catch (error) {
    if (!(error instanceof TelegramError)) throw error;
    // Pressing the same button twice changes nothing; Telegram calls that an error.
    if (!/message is not modified/i.test(error.description)) {
      await ctx.api
        .call("sendMessage", { chat_id: message.chat.id, ...body })
        .catch(() => undefined);
    }
  }
  return answer(screen.note);
}

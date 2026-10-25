/**
 * What the bot says, in English and Russian, picked by the sender's Telegram
 * language. Telegram HTML: only <b>, <i>, <code>, <a> are used, and every
 * interpolated value goes through `escapeHtml`.
 */

import type { RelayState } from "../relay";

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const en = {
  notAllowed: (id: number) =>
    `This bot is private. Your Telegram ID is <code>${id}</code> — ask its owner to add it to <code>ALLOWED_USER_IDS</code>.`,
  menuIntro: (id: number) =>
    "Hi! I connect your AI assistant (Claude, ChatGPT, Codex) to Telegram: it can message you here, send files, ask you questions with buttons, and read what you send me or what is said in groups you connect.\n\n" +
    `Your Telegram ID: <code>${id}</code>`,
  menuNotConnected:
    "To start, add this bot as a connector in Claude or ChatGPT and sign in with Telegram. Then this menu opens up.",
  helpScreen: (p: { retention: number; privacyOn: boolean }) =>
    [
      "<b>How it works</b>",
      "Your assistant reaches you through me: messages, files, questions with buttons. It reads what you send me and what is said in groups you connect.",
      "",
      `I keep messages for ${p.retention} days and only see chats I am in.` +
        (p.privacyOn
          ? " Privacy mode is on, so in groups I only see commands, mentions and replies to me — turn it off in @BotFather (/setprivacy) and re-add me to see everything."
          : ""),
      "",
      "<b>Commands</b>",
      "/start — this menu",
      "/groups — connected groups",
      "/disconnect — sign out every connected assistant",
    ].join("\n"),
  personalScreen:
    "<b>Personal chats</b>\n\nTo let your assistant read your own chats with other people, add me in Settings → Telegram Business → Chatbots. Whether it may also reply for you is up to the permissions you give me there.",
  // Spelled with the bot's name: with privacy mode on and other bots in the
  // group, a bare /connect may never reach this one.
  addScreen: (bot: string) =>
    `<b>Connect a group</b>\n\nAdd me with the button below — whoever adds me gets access right away.\n\nAlready in the group? Send <code>/connect@${bot}</code> there.`,
  connectInPrivate: (bot: string) =>
    `Add me to a group with the button below, or send <code>/connect@${bot}</code> in a group I'm already in.`,
  groupScreen: (p: { title: string; full: boolean; since: string }) =>
    `<b>${escapeHtml(p.title)}</b>\n\n` +
    (p.full
      ? "Your assistant sees everything I have stored here."
      : `Your assistant sees messages from ${p.since}.`),
  noGroupsMenu: "No groups connected yet. Add me to a group to start.",
  useMenu: "That picker is gone. Send /start for the menu.",
  menuGone: "That group is not connected for you.",
  buttonGroups: "👥 Groups",
  buttonAdd: "➕ Connect a group",
  buttonPersonal: "🔗 Personal chats",
  buttonHelp: "❓ How it works",
  buttonBack: "« Back",
  buttonAddToGroup: "Add to a group",
  buttonRevoke: "Revoke access",
  someAssistant: "An assistant",
  memoryOfMe: "Chat with me",
  memoryNotice: (p: { client: string; chat: string; diff: string }) =>
    `📝 <b>${escapeHtml(p.client)}</b> changed the memory of <b>${escapeHtml(p.chat)}</b>\n\n<pre>${p.diff}</pre>`,
  memoryNoVisibleChange: "(only blank lines or order changed)",
  memoryMoreLines: (n: number) => `… and ${n} more changed line(s)`,
  buttonUndo: "Undo",
  buttonUndoAnyway: "Undo anyway",
  undone: "Undone.",
  undoGone: "That change is too old to undo.",
  undoConfirm: (later: number) =>
    `The memory changed ${later} more time(s) since. Undoing goes back to before this change and drops those too.`,
  buttonMemory: "📝 Memory",
  buttonChatMemory: "📝 Chat memory",
  memoryListScreen: (lines: string[]) =>
    lines.length
      ? `<b>Memory</b>\nWhat your assistants keep about each chat. Tap one to read or delete it.\n\n${lines.join("\n")}`
      : "<b>Memory</b>\n\nNothing yet. Ask your assistant to remember something about a chat.",
  memoryLine: (p: { chat: string; size: number; date: string }) =>
    `• <b>${escapeHtml(p.chat)}</b> — ${p.size} characters, ${p.date}`,
  memoryDoc: (p: { chat: string; content: string }) =>
    `<b>Memory: ${escapeHtml(p.chat)}</b>\n\n<pre>${escapeHtml(p.content)}</pre>`,
  memoryAsFile: (chat: string) =>
    `<b>Memory: ${escapeHtml(chat)}</b>\n\nIt is long, so I sent it as a file.`,
  memoryNone: (chat: string) =>
    `<b>Memory: ${escapeHtml(chat)}</b>\n\nNothing kept for this chat yet.`,
  buttonDelete: "🗑 Delete",
  confirmDeleteMemory: (chat: string) =>
    `Delete the memory of <b>${escapeHtml(chat)}</b>, with its history? This cannot be undone.`,
  buttonConfirmDelete: "Yes, delete",
  memoryDeleted: "Deleted.",
  buttonWipe: "🗑 Erase all memory",
  confirmWipe: "Erase the memory of every chat, with its history? This cannot be undone.",
  buttonConfirmWipe: "Yes, erase everything",
  memoryWiped: "All memory erased.",
  buttonSignIns: "🔑 Sign-ins",
  buttonSignOutAll: "Sign out everywhere",
  buttonConfirmSignOut: "Yes, sign out everywhere",
  buttonCancel: "Cancel",
  signInsScreen: (lines: string[]) =>
    lines.length
      ? `<b>Sign-ins</b>\nWhere an assistant is signed in with your account. Tap one to sign it out.\n\n${lines.join("\n")}`
      : "<b>Sign-ins</b>\n\nNo assistant is signed in with your account.",
  signInLine: (p: { client: string; since: string | null; seen: string }) =>
    `• <b>${escapeHtml(p.client)}</b> — ${p.since ? `signed in ${p.since}, ` : ""}last seen ${p.seen}`,
  signOutButton: (client: string) => `Sign out ${client}`,
  unknownClient: "Unknown client",
  signedOut: "Signed out.",
  alreadySignedOut: "Already signed out.",
  confirmSignOutAll:
    "Sign out every assistant connected with your account? Each of them will have to sign in again.",
  connectFirst:
    "Connect your AI assistant to this bot first (add it as a connector in Claude or ChatGPT and sign in with Telegram), then link groups.",
  leavingNotConnected: (name: string) =>
    `${escapeHtml(name)}, connect your AI assistant to this bot first, then add me again. Leaving for now.`,
  notInGroup:
    "I'm not in that group. Add me there first — whoever adds me gets access automatically.",
  notMember: "You don't seem to be a member of that group, so I can't give you access to it.",
  notAGroup: "That isn't a group.",
  connected: (p: { title: string; full: boolean; retention: number; name?: string }) =>
    `✅ ${p.name ? `${escapeHtml(p.name)}: ` : ""}<b>${escapeHtml(p.title)}</b> is connected. ` +
    (p.full
      ? `Your assistant sees everything I have stored here (up to ${p.retention} days).`
      : "Your assistant sees messages from now on. Older ones stay hidden because this group hides history from new members, or I'm not an admin and can't check — make me an admin with visible history to change that."),
  addedGreeting: (p: { name: string; retention: number; privacyOn: boolean; admin: boolean }) =>
    `👋 Hi! ${escapeHtml(p.name)} added me so their AI assistant can read and post here. ` +
    `I keep messages for ${p.retention} days.` +
    (p.privacyOn && !p.admin
      ? "\n\n⚠️ Privacy mode is on: I only see commands, mentions and replies. Make me an admin, or turn privacy off in @BotFather and re-add me."
      : ""),
  noGroups: "No groups connected. Add me to a group, or send /connect in a group I'm already in.",
  groupsHeader: "<b>Connected groups</b>",
  groupLine: (p: { mark?: string; title: string; full: boolean; since: string }) =>
    `• ${p.mark ?? ""}<b>${escapeHtml(p.title)}</b> — ${p.full ? "full stored history" : `from ${p.since}`}`,
  revokeButton: (title: string) => `Revoke ${title}`,
  revoked: "Access revoked.",
  notYours: "Nothing to revoke.",
  disconnected:
    "Done — every assistant signed in with your account is disconnected. Connect again from your assistant's settings when you want.",
  pressed: (label: string) => `✓ ${label}`,
  alreadyAnswered: "Already answered.",
  unknownCommand: "Unknown command. Try /start.",
  business: (p: BusinessStatus) =>
    [
      p.changed
        ? "🔗 Permissions for your personal chats changed."
        : "🔗 You connected me to your account. Your assistant can now read the personal chats you gave me in Telegram's settings, from this moment on. Secret chats, groups and older messages stay out of reach.",
      "",
      "What your assistant may do there:",
      `${p.reply ? "✅" : "🚫"} reply on your behalf — people will see these messages as yours`,
      `${p.read ? "✅" : "🚫"} mark messages as read`,
      `${p.delete ? "✅" : "🚫"} delete messages it sent`,
      "",
      `Only you decide this: Settings → Telegram Business → Chatbots. I keep messages for ${p.retention} days; removing me there deletes them.` +
        (p.signedIn
          ? ""
          : "\n\n⚠️ Connect your AI assistant to this bot first (add it as a connector and sign in with Telegram). Until then I store nothing."),
    ].join("\n"),
  businessOff:
    "🔗 You disconnected me from your account. Everything I stored from your personal chats is deleted.",
  buttonRoutine: "🤖 Claude on tag",
  routineScreen: (p: { state: "none" | "set" | "broken"; trigger?: string; since?: string }) =>
    "<b>Claude on tag</b>\n\nA Claude Code cloud session that I start for you: it does the work and answers in Telegram. It is your routine on claude.ai and runs on your account.\n\n" +
    (p.state === "set"
      ? `✅ Routine <code>${escapeHtml(p.trigger ?? "")}</code>, set ${p.since}.`
      : p.state === "broken"
        ? "⚠️ I can no longer read the saved token: the bot's token changed. Send the routine again."
        : "Not set up yet: follow the guide, then send me the routine's trigger and token."),
  routineGuide:
    "<b>Setting it up</b>\n\n" +
    "1. Open routines on claude.ai → New routine.\n" +
    "2. Paste the prompt from «Send the prompt». Model: Sonnet. Attach the repositories Claude may work in, if any. Keep the connectors: Telegram must be among them.\n" +
    "3. Add trigger → API → Generate token. Copy the trigger id (trig_…) and the token.\n" +
    "4. Send me both in one message. I delete it right away, keep the token encrypted, and start a test session that writes «ok» here.",
  buttonOpenRoutines: "Open routines",
  buttonSendPrompt: "📋 Send the prompt",
  buttonSetRoutine: "🔑 Set the routine",
  buttonGuide: "📖 Guide",
  buttonTestRoutine: "▶️ Test start",
  buttonDeleteRoutine: "🗑 Remove",
  routinePromptIntro: "The routine's prompt — tap the block to copy it:",
  promptSent: "Sent below.",
  setRoutineAsk:
    "Send the trigger id and the token in one message:\n<code>trig_… sk-ant-oat01-…</code>",
  setRoutineNote: "Waiting for the trigger and the token.",
  confirmDeleteRoutine:
    "Remove the routine here? I will stop starting it. It stays on claude.ai — revoke its token there too.",
  buttonConfirmRemove: "Remove",
  routineDeleted: "Removed.",
  routineSaved: (trigger: string, deleted: boolean) =>
    `✅ Saved routine <code>${escapeHtml(trigger)}</code>. The token is kept only encrypted` +
    (deleted ? ", and I deleted your message." : "."),
  routineNotSaved: "⚠️ Could not save the routine. Send it again in a minute.",
  deleteYourself:
    "⚠️ I could not delete your message: delete it yourself, and if others can see this chat, generate a new token.",
  testTooSoon:
    "A test session was started less than a minute ago. Wait for its «ok», or try again shortly.",
  testStarted: (url: string) =>
    `▶️ Started a test session (<a href="${escapeHtml(url)}">open</a>). If everything is set up, it writes «ok» here within a minute or two.`,
  fireFailed: (reason: FireFailure, retryMinutes?: number) =>
    "⚠️ Could not start the routine: " +
    {
      token:
        "its token was refused. Generate a new one in the routine's trigger and send it again.",
      missing: "there is no such trigger. Check the trig_… id.",
      paused: "it is paused on claude.ai.",
      limit: `its start limit is reached. Try again in ${retryMinutes ?? 60} min.`,
      other: "Anthropic's API did not accept the start. Try again later.",
      none: "none is set up.",
      broken: "I can no longer read its token. Send the routine again.",
    }[reason],
  inChat: (title: string) => `«${escapeHtml(title)}»:`,
  tooManyStarts: "⚠️ Too many starts in the last hour; I start no more until it passes.",
  startsButton: "📜 Starts",
  startsScreen: (title: string, lines: string[]) =>
    `<b>${escapeHtml(title)}</b> — latest starts, newest first (UTC):\n\n${lines.join("\n")}`,
  startsEmpty: (title: string) => `<b>${escapeHtml(title)}</b>: no starts yet.`,
  startsSession: "session",
  startsLimited: (n: number) => `😴 ${n} more held back by the limit in the last 24 hours.`,
  buttonRelay: (state: RelayState) =>
    `🛰 Relay: ${{ none: "off", online: "online ✅", offline: "offline ⚠️", login: "sign-in needed ⚠️" }[state]}`,
  relayScreen: (p: { state: RelayState; seen: string | null }) =>
    "🛰 <b>Relay</b>\n\nSessions cannot write to one another by themselves. A relay can: a machine of yours " +
    "signed in to Claude Code that I hand messages to. With it, a reply to a session's message goes to that " +
    "session instead of starting a new one, and sessions can ask each other how things are going. Without it " +
    "everything works as before.\n\n" +
    {
      none: "Not set up. Any always-on Linux machine will do (an Oracle free VM, for one): get the install command and run it there.",
      online: "✅ Online.",
      offline: `⚠️ Offline${p.seen ? ` since ${p.seen}` : " — it has not called in yet"}. Check the machine: <code>systemctl status tg-relay</code>.`,
      login:
        "⚠️ Its Claude sign-in expired. On the machine: <code>claude</code>, then /login, then <code>sudo systemctl restart tg-relay</code>.",
    }[p.state],
  buttonRelayInstall: "📋 Install command",
  buttonRelayOff: "Turn off",
  relayInstall: (command: string) =>
    "Run this on the machine (Linux with systemd; it asks for sudo). It installs Claude Code if needed and " +
    `starts the relay as a service:\n<pre>${escapeHtml(command)}</pre>\nThen sign Claude Code in there once: ` +
    "<code>claude</code>, then /login, then <code>sudo systemctl restart tg-relay</code>. This command holds the " +
    "relay's token — getting a new one turns the old one off.",
  relayOff: "Relay turned off.",
  relayLoginLost:
    "⚠️ The relay's Claude sign-in expired, so replies to sessions start new sessions instead. On the machine: <code>claude</code>, then /login, then <code>sudo systemctl restart tg-relay</code>.",
  relayWentOffline:
    "⚠️ The relay has gone quiet: messages to sessions are not getting through, and replies start new sessions instead. Check the machine: <code>systemctl status tg-relay</code>.",
  claudeHere: (on: boolean): string => (on ? "💬 Here: on ✅" : "💬 Here: off"),
  claudeHereHint:
    "Here: every message goes to Claude — with the 🛰 relay, the day's messages go to one session (from 00:00 UTC), and a reply to a session's message goes back to that session; without it, each message starts its own. In groups, turn it on in 👥 Groups.",
  claudeToggle: (on: boolean): string => (on ? "🤖 Claude answers: ✅" : "🤖 Claude answers: off"),
  othersToggle: (on: boolean): string => (on ? "👥 Others too: ⚠️ on" : "👥 Others too: off"),
  groupClaude: (p: { on: boolean; others: boolean; limit: number; heldBy: string | null }) =>
    p.heldBy
      ? `\n\n🤖 Claude answers here for ${p.heldBy}. You can turn it on once they turn it off.`
      : p.on
        ? `\n\n🤖 A mention of me or a reply to your assistant's message starts Claude — for you` +
          (p.others ? `, and ⚠️ for everyone else here, up to ${p.limit} times an hour.` : " only.")
        : "",
  chatHeld: "Claude already answers here for someone else.",
  othersLimitButton: (limit: number) => `⏱ Others: up to ${limit}/h`,
  othersLimited: (limit: number) =>
    `😴 Other members used up ${limit} starts this hour; theirs wait until it passes (they see 😴). Change the limit in 👥 Groups.`,
  routineFirst: "Set up 🤖 Claude on tag first.",
  othersWarning: (title: string) =>
    `⚠️ Claude will answer the members of «${escapeHtml(title)}». It is told not to do what they ask or share your data unless your memory for this chat allows it. But that is a guard of instructions, not of access: the session has your connectors, chats and repositories, and a clever message can talk it round. Turn it on where you trust people. Every start goes into 📜 Starts here.`,
  buttonTurnOn: "Turn on",
  privacyHint:
    "👁 I am not an admin here and privacy mode is on: I see only mentions and replies, so Claude may miss the context. Make me an admin to fix it.",
  testPassed: (at: string) => `✅ The test start at ${at} answered: it works.`,
  testWaiting: (at: string) =>
    `⏳ Test started at ${at}, no answer yet. If none comes, check that the routine has the Telegram connector.`,
  secretDropped: (deleted: boolean) =>
    (deleted
      ? "That looked like an API key, so I deleted the message and kept nothing."
      : "That looked like an API key, so I kept nothing.") +
    " To set the routine, send its trig_… id and the token together, in one message.",
};

type FireFailure = "token" | "missing" | "paused" | "limit" | "other" | "none" | "broken";

interface BusinessStatus {
  changed: boolean;
  reply: boolean;
  read: boolean;
  delete: boolean;
  retention: number;
  signedIn: boolean;
}

type Texts = typeof en;

const ru: Texts = {
  notAllowed: (id) =>
    `Это приватный бот. Твой Telegram ID: <code>${id}</code> — попроси владельца добавить его в <code>ALLOWED_USER_IDS</code>.`,
  menuIntro: (id) =>
    "Привет! Я связываю твоего AI-ассистента (Claude, ChatGPT, Codex) с Telegram: он может писать тебе сюда, присылать файлы, задавать вопросы с кнопками и читать, что ты мне пишешь или что пишут в подключённых группах.\n\n" +
    `Твой Telegram ID: <code>${id}</code>`,
  menuNotConnected:
    "Для начала добавь этого бота как коннектор в Claude или ChatGPT и войди через Telegram. Тогда откроется меню.",
  helpScreen: (p) =>
    [
      "<b>Как это работает</b>",
      "Ассистент связывается с тобой через меня: сообщения, файлы, вопросы с кнопками. Он читает, что ты мне пишешь и что пишут в подключённых группах.",
      "",
      `Храню сообщения ${p.retention} дней и вижу только чаты, где я есть.` +
        (p.privacyOn
          ? " Включён privacy mode: в группах я вижу только команды, упоминания и ответы мне — выключи его в @BotFather (/setprivacy) и добавь меня заново, чтобы видеть всё."
          : ""),
      "",
      "<b>Команды</b>",
      "/start — это меню",
      "/groups — подключённые группы",
      "/disconnect — отключить все подключённые ассистенты",
    ].join("\n"),
  personalScreen:
    "<b>Личные переписки</b>\n\nЧтобы ассистент читал твои переписки с другими людьми, добавь меня в Настройки → Telegram для бизнеса → Чат-боты. Может ли он ещё и отвечать за тебя — решают права, которые ты дашь мне там.",
  addScreen: (bot) =>
    `<b>Подключить группу</b>\n\nДобавь меня кнопкой ниже — тот, кто добавляет, сразу получает доступ.\n\nЯ уже в группе? Отправь <code>/connect@${bot}</code> прямо там.`,
  connectInPrivate: (bot) =>
    `Добавь меня в группу кнопкой ниже или отправь <code>/connect@${bot}</code> в группе, где я уже есть.`,
  groupScreen: (p) =>
    `<b>${escapeHtml(p.title)}</b>\n\n` +
    (p.full
      ? "Ассистенту видно всё, что я здесь сохранил."
      : `Ассистенту видны сообщения с ${p.since}.`),
  noGroupsMenu: "Подключённых групп пока нет. Добавь меня в группу, чтобы начать.",
  useMenu: "Этого выбора больше нет. Отправь /start, чтобы открыть меню.",
  menuGone: "Эта группа у тебя не подключена.",
  buttonGroups: "👥 Группы",
  buttonAdd: "➕ Подключить группу",
  buttonPersonal: "🔗 Личные переписки",
  buttonHelp: "❓ Как это работает",
  buttonBack: "« Назад",
  buttonAddToGroup: "Добавить в группу",
  buttonRevoke: "Отозвать доступ",
  someAssistant: "Ассистент",
  memoryOfMe: "Чат со мной",
  memoryNotice: (p) =>
    `📝 <b>${escapeHtml(p.client)}</b> изменил память «<b>${escapeHtml(p.chat)}</b>»\n\n<pre>${p.diff}</pre>`,
  memoryNoVisibleChange: "(поменялись только пустые строки или порядок)",
  memoryMoreLines: (n) => `… и ещё строк изменено: ${n}`,
  buttonUndo: "Отменить",
  buttonUndoAnyway: "Всё равно отменить",
  undone: "Отменено.",
  undoGone: "Это изменение слишком старое, отменить нельзя.",
  undoConfirm: (later) =>
    `После этого память менялась ещё ${later} раз(а). Отмена вернёт её к состоянию до этого изменения и уберёт и их.`,
  buttonMemory: "📝 Память",
  buttonChatMemory: "📝 Память чата",
  memoryListScreen: (lines) =>
    lines.length
      ? `<b>Память</b>\nЧто ассистенты помнят о каждом чате. Нажми, чтобы прочитать или удалить.\n\n${lines.join("\n")}`
      : "<b>Память</b>\n\nПока пусто. Попроси ассистента запомнить что-нибудь о чате.",
  memoryLine: (p) => `• <b>${escapeHtml(p.chat)}</b> — ${p.size} символов, ${p.date}`,
  memoryDoc: (p) => `<b>Память: ${escapeHtml(p.chat)}</b>\n\n<pre>${escapeHtml(p.content)}</pre>`,
  memoryAsFile: (chat) =>
    `<b>Память: ${escapeHtml(chat)}</b>\n\nОна длинная, поэтому прислал её файлом.`,
  memoryNone: (chat) =>
    `<b>Память: ${escapeHtml(chat)}</b>\n\nОб этом чате пока ничего не сохранено.`,
  buttonDelete: "🗑 Удалить",
  confirmDeleteMemory: (chat) =>
    `Удалить память «<b>${escapeHtml(chat)}</b>» вместе с историей? Отменить будет нельзя.`,
  buttonConfirmDelete: "Да, удалить",
  memoryDeleted: "Удалено.",
  buttonWipe: "🗑 Стереть всю память",
  confirmWipe: "Стереть память всех чатов вместе с историей? Отменить будет нельзя.",
  buttonConfirmWipe: "Да, стереть всё",
  memoryWiped: "Вся память стёрта.",
  buttonSignIns: "🔑 Входы",
  buttonSignOutAll: "Выйти везде",
  buttonConfirmSignOut: "Да, выйти везде",
  buttonCancel: "Отмена",
  signInsScreen: (lines) =>
    lines.length
      ? `<b>Входы</b>\nГде под твоим аккаунтом вошёл ассистент. Нажми, чтобы выйти.\n\n${lines.join("\n")}`
      : "<b>Входы</b>\n\nПод твоим аккаунтом не вошёл ни один ассистент.",
  signInLine: (p) =>
    `• <b>${escapeHtml(p.client)}</b> — ${p.since ? `вошёл ${p.since}, ` : ""}последняя активность ${p.seen}`,
  signOutButton: (client) => `Выйти: ${client}`,
  unknownClient: "Неизвестный клиент",
  signedOut: "Вход завершён.",
  alreadySignedOut: "Этот вход уже завершён.",
  confirmSignOutAll:
    "Выйти из всех ассистентов, подключённых под твоим аккаунтом? Каждому придётся войти заново.",
  connectFirst:
    "Сначала подключи AI-ассистента к этому боту (добавь коннектор в Claude или ChatGPT и войди через Telegram), потом привязывай группы.",
  leavingNotConnected: (name) =>
    `${escapeHtml(name)}, сначала подключи AI-ассистента к этому боту, потом добавь меня снова. Пока выхожу.`,
  notInGroup:
    "Меня нет в этой группе. Сначала добавь меня — тот, кто добавляет, получает доступ сразу.",
  notMember: "Похоже, ты не участник этой группы, поэтому доступ дать не могу.",
  notAGroup: "Это не группа.",
  connected: (p) =>
    `✅ ${p.name ? `${escapeHtml(p.name)}: ` : ""}<b>${escapeHtml(p.title)}</b> подключена. ` +
    (p.full
      ? `Ассистенту видно всё, что я здесь сохранил (до ${p.retention} дней).`
      : "Ассистенту видны сообщения с этого момента. Старые скрыты: в группе история скрыта от новых участников, или я не админ и не могу это проверить — сделай меня админом с видимой историей, чтобы это изменить."),
  addedGreeting: (p) =>
    `👋 Привет! ${escapeHtml(p.name)} добавил(а) меня, чтобы AI-ассистент мог читать и писать здесь. ` +
    `Храню сообщения ${p.retention} дней.` +
    (p.privacyOn && !p.admin
      ? "\n\n⚠️ Включён privacy mode: я вижу только команды, упоминания и ответы. Сделай меня админом или выключи privacy в @BotFather и добавь меня заново."
      : ""),
  noGroups:
    "Нет подключённых групп. Добавь меня в группу или отправь /connect в группе, где я уже есть.",
  groupsHeader: "<b>Подключённые группы</b>",
  groupLine: (p) =>
    `• ${p.mark ?? ""}<b>${escapeHtml(p.title)}</b> — ${p.full ? "вся сохранённая история" : `с ${p.since}`}`,
  revokeButton: (title) => `Отозвать ${title}`,
  revoked: "Доступ отозван.",
  notYours: "Нечего отзывать.",
  disconnected:
    "Готово — все ассистенты, подключённые под твоим аккаунтом, отключены. Подключиться снова можно в настройках ассистента.",
  pressed: (label) => `✓ ${label}`,
  alreadyAnswered: "Уже отвечено.",
  unknownCommand: "Не знаю такой команды. Попробуй /start.",
  business: (p) =>
    [
      p.changed
        ? "🔗 Права в личных переписках изменились."
        : "🔗 Ты подключил(а) меня к своему аккаунту. Теперь ассистент может читать личные переписки, которые ты отдал(а) мне в настройках Telegram, начиная с этого момента. Секретные чаты, группы и старые сообщения недоступны.",
      "",
      "Что ассистент может делать в них:",
      `${p.reply ? "✅" : "🚫"} отвечать от твоего имени — собеседники увидят это как твои сообщения`,
      `${p.read ? "✅" : "🚫"} отмечать сообщения прочитанными`,
      `${p.delete ? "✅" : "🚫"} удалять отправленные им сообщения`,
      "",
      `Решаешь только ты: Настройки → Telegram для бизнеса → Чат-боты. Храню сообщения ${p.retention} дней; если убрать меня там, всё удалю.` +
        (p.signedIn
          ? ""
          : "\n\n⚠️ Сначала подключи AI-ассистента к этому боту (добавь коннектор и войди через Telegram). До этого я ничего не сохраняю."),
    ].join("\n"),
  businessOff:
    "🔗 Ты отключил(а) меня от своего аккаунта. Всё, что я сохранил из личных переписок, удалено.",
  buttonRoutine: "🤖 Claude по тегу",
  routineScreen: (p) =>
    "<b>Claude по тегу</b>\n\nОблачная сессия Claude Code, которую я запускаю для тебя: она делает работу и отвечает в Telegram. Это твоя рутина на claude.ai, она работает от твоего аккаунта.\n\n" +
    (p.state === "set"
      ? `✅ Рутина <code>${escapeHtml(p.trigger ?? "")}</code>, задана ${p.since}.`
      : p.state === "broken"
        ? "⚠️ Я больше не могу прочитать сохранённый токен: сменился токен бота. Пришли рутину заново."
        : "Ещё не настроено: пройди инструкцию и пришли мне триггер и токен рутины."),
  routineGuide:
    "<b>Настройка</b>\n\n" +
    "1. Открой рутины на claude.ai → New routine.\n" +
    "2. Вставь промпт из «Прислать промпт». Модель — Sonnet. Подключи репозитории, в которых Claude может работать, если нужны. Коннекторы оставь: среди них должен быть Telegram.\n" +
    "3. Add trigger → API → Generate token. Скопируй id триггера (trig_…) и токен.\n" +
    "4. Пришли мне оба одним сообщением. Я сразу его удалю, токен сохраню только в зашифрованном виде и запущу тестовую сессию — она напишет сюда «ok».",
  buttonOpenRoutines: "Открыть рутины",
  buttonSendPrompt: "📋 Прислать промпт",
  buttonSetRoutine: "🔑 Задать рутину",
  buttonGuide: "📖 Инструкция",
  buttonTestRoutine: "▶️ Тестовый запуск",
  buttonDeleteRoutine: "🗑 Удалить",
  routinePromptIntro: "Промпт рутины — нажми на блок, чтобы скопировать:",
  promptSent: "Прислал ниже.",
  setRoutineAsk: "Пришли id триггера и токен одним сообщением:\n<code>trig_… sk-ant-oat01-…</code>",
  setRoutineNote: "Жду триггер и токен.",
  confirmDeleteRoutine:
    "Удалить рутину отсюда? Я перестану её запускать. На claude.ai она останется — отзови там и её токен.",
  buttonConfirmRemove: "Удалить",
  routineDeleted: "Удалено.",
  routineSaved: (trigger, deleted) =>
    `✅ Рутина <code>${escapeHtml(trigger)}</code> сохранена. Токен хранится только зашифрованным` +
    (deleted ? ", а твоё сообщение я удалил." : "."),
  routineNotSaved: "⚠️ Не получилось сохранить рутину. Пришли её ещё раз через минуту.",
  deleteYourself:
    "⚠️ Не получилось удалить твоё сообщение: удали его сам, а если этот чат видят другие — сгенерируй новый токен.",
  testTooSoon:
    "Тестовая сессия уже запущена меньше минуты назад. Дождись её «ok» или попробуй чуть позже.",
  testStarted: (url) =>
    `▶️ Запустил тестовую сессию (<a href="${escapeHtml(url)}">открыть</a>). Если всё настроено, через минуту-две она напишет сюда «ok».`,
  fireFailed: (reason, retryMinutes) =>
    "⚠️ Не получилось запустить рутину: " +
    {
      token: "её токен не принят. Сгенерируй новый в триггере рутины и пришли заново.",
      missing: "такого триггера нет. Проверь id trig_….",
      paused: "она на паузе на claude.ai.",
      limit: `исчерпан лимит запусков. Попробуй через ${retryMinutes ?? 60} мин.`,
      other: "API Anthropic не принял запуск. Попробуй позже.",
      none: "она не задана.",
      broken: "я больше не могу прочитать её токен. Пришли рутину заново.",
    }[reason],
  inChat: (title) => `«${escapeHtml(title)}»:`,
  tooManyStarts: "⚠️ Слишком много запусков за последний час; новых не будет, пока он не пройдёт.",
  startsButton: "📜 Запуски",
  startsScreen: (title, lines) =>
    `<b>${escapeHtml(title)}</b> — последние запуски, сначала новые (UTC):\n\n${lines.join("\n")}`,
  startsEmpty: (title) => `<b>${escapeHtml(title)}</b>: запусков пока не было.`,
  startsSession: "сессия",
  startsLimited: (n) => `😴 Ещё ${n} — придержаны лимитом за последние 24 часа.`,
  buttonRelay: (state) =>
    `🛰 Ретранслятор: ${{ none: "выкл", online: "онлайн ✅", offline: "офлайн ⚠️", login: "нужен вход ⚠️" }[state]}`,
  relayScreen: (p) =>
    "🛰 <b>Ретранслятор</b>\n\nСессии не умеют сами писать друг другу. Ретранслятор умеет: это твоя машина " +
    "с залогиненным Claude Code, которой я передаю сообщения. С ним реплай на сообщение сессии уходит в эту " +
    "сессию, а не запускает новую, и сессии могут спрашивать друг у друга, как дела. Без него всё работает " +
    "как раньше.\n\n" +
    {
      none: "Не настроен. Подойдёт любая всегда включённая машина с Linux (например, бесплатная ВМ Oracle): получи команду установки и выполни её там.",
      online: "✅ Онлайн.",
      offline: `⚠️ Офлайн${p.seen ? ` с ${p.seen}` : " — ещё ни разу не выходил на связь"}. Проверь машину: <code>systemctl status tg-relay</code>.`,
      login:
        "⚠️ Слетел вход в Claude. На машине: <code>claude</code>, затем /login, затем <code>sudo systemctl restart tg-relay</code>.",
    }[p.state],
  buttonRelayInstall: "📋 Команда установки",
  buttonRelayOff: "Отключить",
  relayInstall: (command) =>
    "Выполни на машине (Linux с systemd; попросит sudo). Команда при необходимости поставит Claude Code и " +
    `запустит ретранслятор как сервис:\n<pre>${escapeHtml(command)}</pre>\nПотом один раз войди там в Claude Code: ` +
    "<code>claude</code>, затем /login, затем <code>sudo systemctl restart tg-relay</code>. В команде токен " +
    "ретранслятора — новая команда отключает старый.",
  relayOff: "Ретранслятор отключён.",
  relayLoginLost:
    "⚠️ У ретранслятора слетел вход в Claude, поэтому реплаи сессиям запускают новые сессии. На машине: <code>claude</code>, затем /login, затем <code>sudo systemctl restart tg-relay</code>.",
  relayWentOffline:
    "⚠️ Ретранслятор замолчал: сообщения сессиям не доходят, реплаи запускают новые сессии. Проверь машину: <code>systemctl status tg-relay</code>.",
  claudeHere: (on) => (on ? "💬 Здесь: вкл ✅" : "💬 Здесь: выкл"),
  claudeHereHint:
    "Здесь каждое сообщение идёт Claude: с 🛰 ретранслятором сообщения за день уходят в одну сессию (с 00:00 UTC), а реплай на сообщение сессии — обратно в неё; без него каждое сообщение запускает свою. В группах включается в 👥 Группы.",
  claudeToggle: (on) => (on ? "🤖 Claude отвечает: ✅" : "🤖 Claude отвечает: выкл"),
  othersToggle: (on) => (on ? "👥 Отвечать другим: ⚠️ вкл" : "👥 Отвечать другим: выкл"),
  groupClaude: (p) =>
    p.heldBy
      ? `\n\n🤖 Здесь Claude отвечает для ${p.heldBy}. Включить можно, когда он отключит.`
      : p.on
        ? `\n\n🤖 Упоминание меня или реплай на сообщение ассистента запускает Claude — для тебя` +
          (p.others ? `, и ⚠️ для всех остальных здесь — до ${p.limit} раз в час.` : ".")
        : "",
  chatHeld: "Здесь Claude уже отвечает для другого человека.",
  othersLimitButton: (limit) => `⏱ Другим: до ${limit}/ч`,
  othersLimited: (limit) =>
    `😴 Остальные участники исчерпали ${limit} запусков за час; их теги подождут, пока он пройдёт (они видят 😴). Лимит меняется в 👥 Группах.`,
  routineFirst: "Сначала настрой 🤖 Claude по тегу.",
  othersWarning: (title) =>
    `⚠️ Claude будет отвечать участникам «${escapeHtml(title)}». Он настроен не выполнять их просьбы и не делиться твоими данными, если память этого чата это не разрешает. Но это защита инструкциями, а не доступом: у сессии твои коннекторы, чаты и репозитории, и хитрое сообщение может её переубедить. Включай там, где доверяешь людям. Все запуски видны в 📜 Запусках здесь.`,
  buttonTurnOn: "Включить",
  privacyHint:
    "👁 Я здесь не админ, а privacy mode включён: вижу только упоминания и реплаи, так что Claude может не хватить контекста. Сделай меня админом, чтобы это исправить.",
  testPassed: (at) => `✅ Тестовый запуск в ${at} ответил: всё работает.`,
  testWaiting: (at) =>
    `⏳ Тест запущен в ${at}, ответа пока нет. Если не придёт — проверь, что у рутины есть коннектор Telegram.`,
  secretDropped: (deleted) =>
    (deleted
      ? "Это похоже на API-ключ, так что я удалил сообщение и ничего не сохранил."
      : "Это похоже на API-ключ, так что я ничего не сохранил.") +
    " Чтобы задать рутину, пришли id trig_… и токен вместе, одним сообщением.",
};

export function texts(languageCode: string | null | undefined): Texts {
  return languageCode?.toLowerCase().startsWith("ru") ? ru : en;
}

export function formatDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { Harness, ORIGIN, TgError } from "./harness";

const ALICE = { id: 111, first_name: "Alice", username: "alice", language_code: "en" };
const BOB = { id: 222, first_name: "Bob", username: "bob" };
const dm = (user: { id: number }) => ({ id: user.id, type: "private" });
const TEAM = { id: -1001234567890, title: "Team chat", type: "supergroup" };

type Button = { text: string; callback_data?: string; url?: string };
type Reply = { method: string; text: string; reply_markup?: Record<string, unknown> };

let h: Harness;
beforeEach(async () => {
  h = new Harness();
  await h.ensureSchema();
});
afterEach(() => h.restore());

function buttons(markup: unknown): Button[] {
  return ((markup as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? []).flat();
}

/** Press a menu button on message 77 in the user's private chat. */
async function press(user: { id: number }, data: string, id = "q1") {
  await h.update({
    callback_query: {
      id,
      from: { ...user, is_bot: false, first_name: "X" },
      data,
      message: { message_id: 77, date: 1, chat: dm(user) },
    },
  });
  return h.telegram.called("editMessageText").at(-1)?.params;
}

describe("menu", () => {
  it("/start before any assistant signed in offers only how to connect", async () => {
    const reply = (await h.say(dm(ALICE), ALICE, "/start"))._reply as Reply;
    expect(reply.method).toBe("sendMessage");
    expect(reply.text).toContain("<code>111</code>");
    expect(reply.text).not.toContain(ORIGIN);
    const data = buttons(reply.reply_markup).map((b) => b.callback_data);
    expect(data).toEqual(["m:help"]);
  });

  it("/start after signing in shows the main menu as inline buttons", async () => {
    h.markConnected(ALICE);
    const reply = (await h.say(dm(ALICE), ALICE, "/start"))._reply as Reply;
    const data = buttons(reply.reply_markup).map((b) => b.callback_data);
    expect(data).toContain("m:groups");
    expect(data).toContain("m:add");
    expect(data).toContain("m:personal");
    expect(data).toContain("m:help");
    expect(reply.reply_markup).not.toHaveProperty("keyboard");
  });

  it("walks from the group list to a group and revokes it there", async () => {
    await h.addBot(TEAM, ALICE);
    const list = await press(ALICE, "m:groups");
    expect(list!.message_id).toBe(77);
    expect(String(list!.text)).toContain("Team chat");
    expect(buttons(list!.reply_markup).map((b) => b.callback_data)).toContain(`m:g:${TEAM.id}`);

    const group = await press(ALICE, `m:g:${TEAM.id}`, "q2");
    expect(String(group!.text)).toContain("Team chat");
    const data = buttons(group!.reply_markup).map((b) => b.callback_data);
    expect(data).toEqual([`m:gc:${TEAM.id}`, `m:mv:${TEAM.id}`, `m:rv:${TEAM.id}`, "m:groups"]);

    const after = await press(ALICE, `m:rv:${TEAM.id}`, "q3");
    expect(String(after!.text)).not.toContain("Team chat");
    const grants = h.db.raw.query("SELECT COUNT(*) AS n FROM grants").get() as { n: number };
    expect(grants.n).toBe(0);
  });

  it("the add screen links to adding the bot to a group", async () => {
    h.markConnected(ALICE);
    const screen = await press(ALICE, "m:add");
    const link = buttons(screen!.reply_markup).find((b) => b.url);
    expect(link!.url).toBe("https://t.me/test_mcp_bot?startgroup=connect");
    expect(String(screen!.text)).toContain("/connect@test_mcp_bot");
  });

  it("shows the list, not the group, to someone without access to it", async () => {
    await h.addBot(TEAM, ALICE);
    h.markConnected(BOB);
    const screen = await press(BOB, `m:g:${TEAM.id}`);
    expect(String(screen!.text)).not.toContain("Team chat");
    await press(BOB, `m:rv:${TEAM.id}`, "q2");
    const grants = h.db.raw.query("SELECT COUNT(*) AS n FROM grants").get() as { n: number };
    expect(grants.n).toBe(1);
  });

  it("ignores menu presses on messages outside the presser's private chat", async () => {
    h.markConnected(ALICE, BOB);
    for (const chat of [TEAM, dm(BOB)]) {
      await h.update({
        callback_query: {
          id: "x",
          from: { ...ALICE, is_bot: false },
          data: "m:groups",
          message: { message_id: 5, date: 1, chat },
        },
      });
    }
    expect(h.telegram.called("editMessageText")).toHaveLength(0);
  });

  it("refuses presses from users who may not use the bot", async () => {
    h.restore();
    h = new Harness({ ALLOWED_USER_IDS: String(ALICE.id) });
    await h.ensureSchema();
    await press(BOB, "m:groups");
    expect(h.telegram.called("editMessageText")).toHaveLength(0);
    const answer = h.telegram.called("answerCallbackQuery");
    expect(answer).toHaveLength(0); // answered in the webhook reply, not by a call
  });

  it("ignores 'message is not modified' and resends the menu when the edit fails otherwise", async () => {
    h.markConnected(ALICE);
    h.telegram.handlers.set("editMessageText", () => {
      throw new TgError(400, "Bad Request: message is not modified");
    });
    await press(ALICE, "m:help");
    expect(h.telegram.called("sendMessage")).toHaveLength(0);

    h.telegram.handlers.set("editMessageText", () => {
      throw new TgError(400, "Bad Request: message to edit not found");
    });
    await press(ALICE, "m:help", "q2");
    const sent = h.telegram.called("sendMessage").at(-1)!;
    expect(sent.params.chat_id).toBe(ALICE.id);
    expect(buttons(sent.params.reply_markup).map((b) => b.callback_data)).toContain("m:main");
  });

  it("/connect in the private chat points to the group instead of a picker", async () => {
    h.markConnected(ALICE);
    const reply = (await h.say(dm(ALICE), ALICE, "/connect"))._reply as Reply;
    expect(reply.reply_markup).not.toHaveProperty("keyboard");
    expect(buttons(reply.reply_markup).find((b) => b.url)!.url).toContain("startgroup");
  });

  it("answers a stale group-picker keyboard by removing it", async () => {
    h.markConnected(ALICE);
    const reply = (
      await h.say(dm(ALICE), ALICE, "", { chat_shared: { request_id: 1, chat_id: TEAM.id } })
    )._reply as Reply;
    expect(reply.reply_markup).toEqual({ remove_keyboard: true });
    const grants = h.db.raw.query("SELECT COUNT(*) AS n FROM grants").get() as { n: number };
    expect(grants.n).toBe(0);
  });
});

describe("bot commands", () => {
  it("registers only /start in private chats and none in groups", async () => {
    await h.fetch("/", { headers: { accept: "text/html" } });
    const set = h.telegram.called("setMyCommands");
    expect(set.length).toBeGreaterThan(0);
    for (const call of set) {
      expect((call.params.commands as { command: string }[]).map((c) => c.command)).toEqual([
        "start",
      ]);
    }
    const removed = h.telegram.called("deleteMyCommands");
    expect(removed.map((c) => c.params.scope)).toEqual([{ type: "all_group_chats" }]);
  });
});

describe("leaving a group", () => {
  it("a member leaving revokes their access even when the bot is not an admin", async () => {
    await h.addBot(TEAM, ALICE);
    h.markConnected(BOB);
    await h.say(TEAM, BOB, "/connect");
    await h.say(TEAM, BOB, "", {
      left_chat_member: { id: BOB.id, is_bot: false, first_name: "Bob" },
    });
    const grants = h.db.raw.query("SELECT user_id FROM grants").all() as { user_id: number }[];
    expect(grants.map((g) => g.user_id)).toEqual([ALICE.id]);
  });

  it("ignores the service message about the bot itself", async () => {
    await h.addBot(TEAM, ALICE);
    await h.say(TEAM, ALICE, "", {
      left_chat_member: { id: 123456, is_bot: true, first_name: "Test" },
    });
    const grants = h.db.raw.query("SELECT COUNT(*) AS n FROM grants").get() as { n: number };
    expect(grants.n).toBe(1);
  });
});

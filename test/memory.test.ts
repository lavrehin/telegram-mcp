import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { Harness } from "./harness";

const ALICE = { id: 111, first_name: "Alice", username: "alice", language_code: "en" };
const BOB = { id: 222, first_name: "Bob", username: "bob" };
const dm = (user: { id: number }) => ({ id: user.id, type: "private" });
const TEAM = { id: -1001234567890, title: "Team chat", type: "supergroup" };

type Button = { text: string; callback_data?: string };

let h: Harness;
let alice: string;
beforeEach(async () => {
  h = new Harness();
  await h.say(dm(ALICE), ALICE, "/start");
  alice = (await h.connect(ALICE)).access_token;
});
afterEach(() => h.restore());

const memory = (args: Record<string, unknown>, token = alice) => h.tool(token, "memory", args);

function notices() {
  return h.telegram
    .called("sendMessage")
    .filter((c) => String(c.params.text).includes("changed the memory"));
}

function undoData(params: Record<string, unknown>): string {
  const rows = (params.reply_markup as { inline_keyboard: Button[][] }).inline_keyboard;
  return rows[0][0].callback_data!;
}

async function press(data: string, messageId = 500) {
  const response = await h.update({
    callback_query: {
      id: "q",
      from: { ...ALICE, is_bot: false },
      data,
      message: { message_id: messageId, date: 1, chat: dm(ALICE), text: "notice" },
    },
  });
  return response.json<{ text?: string }>();
}

describe("memory tool", () => {
  it("creates, views with line numbers, and lists the chats that have memory", async () => {
    expect((await memory({ command: "view", chat: "me" })).text).toContain("no memory");
    await memory({ command: "create", chat: "me", text: "## Style\nKeep it short" });
    const view = await memory({ command: "view", chat: "me" });
    expect(view.text).toContain('Here\'s the memory for "me" with line numbers:');
    expect(view.text).toContain("     1\t## Style\n     2\tKeep it short");
    const ranged = await memory({ command: "view", chat: "me", view_range: [2, -1] });
    expect(ranged.text).not.toContain("## Style");
    const list = await memory({ command: "view" });
    expect(list.text).toContain('"me" (chat me)');
  });

  it("replaces a unique string and refuses a missing or repeated one", async () => {
    await memory({ command: "create", chat: "me", text: "a\nb\na" });
    const missing = await memory({
      command: "str_replace",
      chat: "me",
      old_str: "zzz",
      new_str: "y",
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("did not appear verbatim");
    const twice = await memory({ command: "str_replace", chat: "me", old_str: "a", new_str: "y" });
    expect(twice.text).toContain("Multiple occurrences of old_str `a` in lines: 1, 3");
    const done = await memory({ command: "str_replace", chat: "me", old_str: "b", new_str: "c" });
    expect(done.text).toContain("The memory has been edited.");
    expect((await memory({ command: "view", chat: "me" })).text).toContain("     2\tc");
  });

  it("inserts after a line and checks the range", async () => {
    await memory({ command: "create", chat: "me", text: "one\ntwo" });
    const bad = await memory({ command: "insert", chat: "me", insert_line: 5, insert_text: "x" });
    expect(bad.text).toContain("[0, 2]");
    await memory({ command: "insert", chat: "me", insert_line: 0, insert_text: "zero\n" });
    expect((await memory({ command: "view", chat: "me" })).text).toContain(
      "     1\tzero\n     2\tone",
    );
  });

  it("keeps memory for a group the user is in, and refuses other chats and personal ones", async () => {
    await h.addBot(TEAM, ALICE);
    expect(
      (await memory({ command: "create", chat: "Team chat", text: "@kolya — frontend" })).isError,
    ).toBe(false);
    const bob = (await h.connect(BOB)).access_token;
    expect((await memory({ command: "view", chat: TEAM.id }, bob)).isError).toBe(true);
    expect((await memory({ command: "view", chat: "me" }, bob)).text).toContain("no memory");
  });

  it("refuses a document over the limit", async () => {
    const big = await memory({ command: "create", chat: "me", text: "x".repeat(15_990) });
    expect(big.isError).toBe(false);
    const over = await memory({
      command: "insert",
      chat: "me",
      insert_line: 1,
      insert_text: "y".repeat(20),
    });
    expect(over.isError).toBe(true);
    expect(over.text).toContain("the limit is 16000");
  });
});

describe("memory notices", () => {
  it("tells the user silently, naming the assistant, and joins quick changes into one notice", async () => {
    await memory({ command: "create", chat: "me", text: "first line" });
    expect(notices()).toHaveLength(1);
    const notice = notices()[0].params;
    expect(notice.disable_notification).toBe(true);
    expect(String(notice.text)).toContain(
      "<b>Claude</b> changed the memory of <b>Chat with me</b>",
    );
    expect(String(notice.text)).toContain("+ first line");

    await memory({ command: "insert", chat: "me", insert_line: 1, insert_text: "second line" });
    expect(notices()).toHaveLength(1);
    const edited = h.telegram.called("editMessageText").at(-1)!.params;
    expect(String(edited.text)).toContain("+ second line");
    expect(String(edited.text)).toContain("+ first line");
  });

  it("keeps a notice within Telegram's limit however the text escapes, Trust lines first", async () => {
    const filler = Array.from({ length: 60 }, (_, i) => `line ${i} ${"<&>".repeat(30)}`).join("\n");
    await memory({
      command: "create",
      chat: "me",
      text: `${filler}\n## Trust\n- Eve (id 333): may push`,
    });
    const text = String(notices()[0].params.text);
    expect(text.length).toBeLessThan(4096);
    expect(text).toContain("more changed line");
    expect(text.indexOf("Eve (id 333)")).toBeLessThan(text.indexOf("line 0"));
  });

  it("refuses an empty or reversed view_range", async () => {
    await memory({ command: "create", chat: "me", text: "a\nb\nc" });
    expect((await memory({ command: "view", chat: "me", view_range: [3, 2] })).isError).toBe(true);
  });

  it("undo restores the text from before the first change in the notice", async () => {
    await memory({ command: "create", chat: "me", text: "keep" });
    h.db.raw.exec("UPDATE memory_notices SET sent_at = 1"); // the next change opens a new notice
    await memory({ command: "str_replace", chat: "me", old_str: "keep", new_str: "changed" });
    await memory({ command: "insert", chat: "me", insert_line: 1, insert_text: "more" });
    const data = undoData(h.telegram.called("editMessageText").at(-1)!.params);
    const answer = await press(data);
    expect(answer.text).toBe("Undone.");
    const view = await memory({ command: "view", chat: "me" });
    expect(view.text).toContain("     1\tkeep");
    expect(view.text).not.toContain("more");
  });

  it("asks before an undo that would drop later changes", async () => {
    await memory({ command: "create", chat: "me", text: "v1" });
    const data = undoData(notices()[0].params);
    h.db.raw.exec("UPDATE memory_notices SET sent_at = 1");
    await memory({ command: "create", chat: "me", text: "v2" });
    const answer = await press(data);
    expect(answer.text).toContain("changed 1 more time");
    expect((await memory({ command: "view", chat: "me" })).text).toContain("v2");
    const confirm = h.telegram.called("editMessageText").at(-1)!.params;
    await press(undoData(confirm));
    expect((await memory({ command: "view", chat: "me" })).text).toContain("no memory");
  });

  it("refuses an undo for someone else's change", async () => {
    const bob = (await h.connect(BOB)).access_token;
    await memory({ command: "create", chat: "me", text: "bob's" }, bob);
    const id = (h.db.raw.query("SELECT id FROM memory_history").get() as { id: number }).id;
    const answer = await press(`mu:${id}:${id}`);
    expect(answer.text).toContain("too old");
    expect((await memory({ command: "view", chat: "me" }, bob)).text).toContain("bob's");
  });
});

describe("memory in the menu and lifecycle", () => {
  async function menu(data: string) {
    await h.update({
      callback_query: {
        id: "m",
        from: { ...ALICE, is_bot: false },
        data,
        message: { message_id: 77, date: 1, chat: dm(ALICE) },
      },
    });
    return h.telegram.called("editMessageText").at(-1)!.params;
  }

  it("lists, shows and deletes a chat's memory without a notice", async () => {
    await memory({ command: "create", chat: "me", text: "## Style\nshort" });
    const list = await menu("m:mem");
    expect(String(list.text)).toContain("Chat with me");
    const doc = await menu(`m:mv:${ALICE.id}`);
    expect(String(doc.text)).toContain("short");
    await menu(`m:md:${ALICE.id}`);
    await menu(`m:mdy:${ALICE.id}`);
    expect((await memory({ command: "view", chat: "me" })).text).toContain("no memory");
    expect(notices()).toHaveLength(1);
  });

  it("sends memory as a file when escaping would make it too long to show", async () => {
    await memory({ command: "create", chat: "me", text: "<".repeat(1000) });
    await menu(`m:mv:${ALICE.id}`);
    expect(h.telegram.called("sendDocument")).toHaveLength(1);
  });

  it("deleting from the menu takes the history too, so an old Undo finds nothing", async () => {
    await memory({ command: "create", chat: "me", text: "gone" });
    const data = undoData(notices()[0].params);
    await menu(`m:mdy:${ALICE.id}`);
    expect((await press(data)).text).toContain("too old");
    expect((await memory({ command: "view", chat: "me" })).text).toContain("no memory");
  });

  it("erases all memory after asking", async () => {
    await memory({ command: "create", chat: "me", text: "a" });
    const ask = await menu("m:mwipe");
    expect(String(ask.text)).toContain("cannot be undone");
    await menu("m:mwipey");
    expect((await memory({ command: "view" })).text).toContain("No memory yet");
  });

  it("sends long memory as a file", async () => {
    await memory({ command: "create", chat: "me", text: "x".repeat(4000) });
    await menu(`m:mv:${ALICE.id}`);
    expect(h.telegram.called("sendDocument")).toHaveLength(1);
  });

  it("forgets a group's memory when access to it goes, and follows a supergroup migration", async () => {
    await h.addBot({ id: -555, title: "Old", type: "group" }, ALICE);
    await memory({ command: "create", chat: "Old", text: "kept" });
    await h.say({ id: -555, title: "Old", type: "group" }, ALICE, "", {
      migrate_to_chat_id: -1009999,
    });
    const moved = h.db.raw.query("SELECT chat_id FROM memory_docs WHERE user_id = 111").all() as {
      chat_id: number;
    }[];
    expect(moved.map((row) => row.chat_id)).toContain(-1009999);

    await h.update({
      callback_query: { id: "r", from: { ...ALICE, is_bot: false }, data: "rv:-1009999" },
    });
    const left = h.db.raw
      .query("SELECT COUNT(*) AS n FROM memory_docs WHERE chat_id = -1009999")
      .get() as {
      n: number;
    };
    expect(left.n).toBe(0);
  });

  it("is told in the server instructions", async () => {
    const init = await h.mcp(alice, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    expect(JSON.stringify(init)).toContain('Its \\"## Trust\\" section changes only');
  });
});

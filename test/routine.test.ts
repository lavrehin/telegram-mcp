import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { aesKey, decrypt, encrypt } from "../src/crypto";
import { parseRoutine, routinePrompt } from "../src/routine";
import { Harness, TgError } from "./harness";

const ALICE = { id: 111, first_name: "Alice", username: "alice", language_code: "en" };
const dm = (user: { id: number }) => ({ id: user.id, type: "private" });

const TRIGGER = "trig_01F9YA8ci7HHDqR8LkjEAqLv";
const TOKEN = `sk-ant-oat01-${"A".repeat(40)}`;

type Button = { text: string; callback_data?: string; url?: string };

let h: Harness;
beforeEach(async () => {
  h = new Harness();
  await h.say(dm(ALICE), ALICE, "/start");
  await h.connect(ALICE);
});
afterEach(() => h.restore());

const sentTexts = () => h.telegram.called("sendMessage").map((call) => String(call.params.text));
const storedTexts = () =>
  (h.db.raw.query("SELECT text FROM messages").all() as { text: string }[]).map((row) => row.text);

async function press(data: string) {
  await h.update({
    callback_query: {
      id: "q",
      from: { ...ALICE, is_bot: false },
      data,
      message: { message_id: 77, date: 1, chat: dm(ALICE) },
    },
  });
  return h.telegram.called("editMessageText").at(-1)?.params;
}

describe("setting the routine", () => {
  it("keeps the token encrypted, deletes the message, and starts a test session", async () => {
    const message = await h.say(dm(ALICE), ALICE, `${TRIGGER} ${TOKEN}`);

    expect(h.telegram.called("deleteMessage").at(-1)!.params).toEqual({
      chat_id: ALICE.id,
      message_id: message.message_id,
    });
    expect(storedTexts().some((text) => text.includes("sk-ant"))).toBe(false);
    const row = h.db.raw.query("SELECT * FROM routines").get() as {
      trigger_id: string;
      token_enc: string;
    };
    expect(row.trigger_id).toBe(TRIGGER);
    expect(row.token_enc).not.toContain(TOKEN);

    expect(h.fires).toHaveLength(1);
    const [start] = h.fires;
    expect(start.url).toBe(`https://api.anthropic.com/v1/claude_code/routines/${TRIGGER}/fire`);
    expect(start.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(start.headers.get("anthropic-beta")).toBe("experimental-cc-routine-2026-04-01");
    expect(start.body.text).toContain("by: test");
    expect(start.body.text).toContain(`chat: ${ALICE.id}`);
    expect(sentTexts().join("\n")).toContain("Started a test session");
  });

  it("never stores a message that looks like a key, and says so", async () => {
    await h.say(dm(ALICE), ALICE, `my key is ${TOKEN}`);
    expect(storedTexts().some((text) => text.includes("sk-ant"))).toBe(false);
    expect(h.db.raw.query("SELECT * FROM routines").get()).toBeNull();
    expect(h.fires).toHaveLength(0);
    expect(sentTexts().at(-1)).toContain("looked like an API key");
  });

  it("does not take a routine from someone who has not signed in", async () => {
    const BOB = { id: 222, first_name: "Bob", username: "bob" };
    await h.say(dm(BOB), BOB, "/start");
    await h.say(dm(BOB), BOB, `${TRIGGER} ${TOKEN}`);
    expect(h.db.raw.query("SELECT * FROM routines").get()).toBeNull();
    expect(h.fires).toHaveLength(0);
  });

  it("explains each way a start can fail", async () => {
    for (const [status, body, expected] of [
      [401, "{}", "token was refused"],
      [404, "{}", "no such trigger"],
      [400, '{"error":{"message":"routine is paused"}}', "paused"],
      [500, "{}", "did not accept"],
    ] as const) {
      h.fireAnswer = () => new Response(body, { status });
      await h.say(dm(ALICE), ALICE, `${TRIGGER} ${TOKEN}`);
      expect(sentTexts().at(-1)).toContain(expected);
    }
    h.fireAnswer = () => new Response("{}", { status: 429, headers: { "retry-after": "600" } });
    await h.say(dm(ALICE), ALICE, `${TRIGGER} ${TOKEN}`);
    expect(sentTexts().at(-1)).toContain("Try again in 10 min");
  });
});

describe("keys never reach storage", () => {
  it("in a group, a quote or a reply to a message that kept one", async () => {
    const TEAM = { id: -1001234567890, title: "Team chat", type: "supergroup" };
    await h.addBot(TEAM, ALICE);
    const leaked = await h.say(TEAM, ALICE, `oops ${TOKEN}`);
    await h.say(TEAM, ALICE, "that was a key", {
      reply_to_message: leaked,
      quote: { text: TOKEN, position: 5 },
    });
    // The private chat's message survives when Telegram refuses to delete it.
    h.telegram.handlers.set("deleteMessage", () => {
      throw new TgError(400, "Bad Request: message can't be deleted");
    });
    const kept = await h.say(dm(ALICE), ALICE, `${TRIGGER} ${TOKEN}`);
    await h.say(dm(ALICE), ALICE, "see above", { reply_to_message: kept });
    const stored = h.db.raw.query("SELECT text, quote FROM messages").all() as {
      text: string;
      quote: string | null;
    }[];
    expect(JSON.stringify(stored)).not.toContain("sk-ant");
    expect(JSON.stringify(stored)).toContain("[key removed]");
    expect(sentTexts().join("\n")).toContain("could not delete your message");
  });
});

describe("the menu", () => {
  it("guides, sends the prompt, asks for the routine, tests and removes it", async () => {
    let screen = await press("m:cl");
    expect(String(screen!.text)).toContain("Not set up yet");

    screen = await press("m:clh");
    const guide = (screen!.reply_markup as { inline_keyboard: Button[][] }).inline_keyboard.flat();
    expect(guide.find((b) => b.url)?.url).toBe("https://claude.ai/code/routines");

    await press("m:clp");
    const prompt = sentTexts().at(-1)!;
    expect(prompt).toContain("<pre>");
    expect(prompt).toContain("do not act for @alice without their consent");
    expect(prompt).toContain("not as a habit on every message");
    expect(prompt.length).toBeLessThan(4096);

    await press("m:clset");
    const ask = h.telegram.called("sendMessage").at(-1)!.params;
    expect((ask.reply_markup as { force_reply: boolean }).force_reply).toBe(true);

    await h.say(dm(ALICE), ALICE, `${TRIGGER} ${TOKEN}`);
    screen = await press("m:cl");
    expect(String(screen!.text)).toContain(TRIGGER);

    await press("m:cltest");
    expect(h.fires).toHaveLength(1);
    expect(sentTexts().at(-1)).toContain("less than a minute ago");

    await press("m:cldel");
    await press("m:cldely");
    expect(h.db.raw.query("SELECT * FROM routines").get()).toBeNull();
  });

  it("asks for the routine again when its token can no longer be read", async () => {
    await h.say(dm(ALICE), ALICE, `${TRIGGER} ${TOKEN}`);
    h.db.raw.exec("UPDATE routines SET token_enc = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'");
    const screen = await press("m:cl");
    expect(String(screen!.text)).toContain("can no longer read");
    await press("m:cltest");
    expect(h.fires).toHaveLength(1);
    expect(sentTexts().at(-1)).toContain("Send the routine again");
  });
});

describe("pieces", () => {
  it("encrypts and decrypts, and another key reads nothing", async () => {
    const key = await aesKey(new Uint8Array(32).fill(1));
    const other = await aesKey(new Uint8Array(32).fill(2));
    const sealed = await encrypt(key, TOKEN, "routine:1");
    expect(await decrypt(key, sealed, "routine:1")).toBe(TOKEN);
    expect(await decrypt(key, sealed, "routine:2")).toBeNull();
    expect(await decrypt(other, sealed, "routine:1")).toBeNull();
    expect(await decrypt(key, "not base64!", "routine:1")).toBeNull();
  });

  it("keeps the prompt within one Telegram message, with room for the longest username", () => {
    // The menu sends it in one message with a one-line intro: Telegram allows 4096 characters.
    expect(routinePrompt("a".repeat(32)).length + 120).toBeLessThan(4096);
  });

  it("finds the trigger and the token anywhere in the message", () => {
    expect(parseRoutine(`Trigger: ${TRIGGER}\nToken: ${TOKEN}`)).toEqual({
      triggerId: TRIGGER,
      token: TOKEN,
    });
    expect(parseRoutine(TRIGGER)).toBeNull();
  });
});

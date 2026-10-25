/**
 * Telegram delivers updates concurrently (up to max_connections at once), so
 * the store's guarantees have to hold when updates overlap or arrive out of
 * order.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { nowSeconds } from "../src/crypto";
import { Store } from "../src/store";
import { Harness } from "./harness";

const ALICE = { id: 111, first_name: "Alice" };
const BOB = { id: 222, first_name: "Bob" };
const TEAM = { id: -1005550001, title: "Team", type: "supergroup" };

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(() => h.restore());

const count = (sql: string, ...args: (string | number)[]) =>
  (h.db.raw.query(sql).get(...args) as { n: number }).n;

describe("concurrent updates", () => {
  it("a retried update is stored once", async () => {
    await h.addBot(TEAM, ALICE);
    const message = {
      message_id: 50,
      date: nowSeconds(),
      chat: TEAM,
      from: { id: BOB.id, is_bot: false, first_name: "Bob" },
      text: "dup",
    };
    await Promise.all([h.update({ message }), h.update({ message }), h.update({ message })]);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?", TEAM.id)).toBe(1);
  });

  it("an edit that overtakes its original keeps the edited text", async () => {
    await h.addBot(TEAM, ALICE);
    const base = {
      message_id: 60,
      date: nowSeconds(),
      chat: TEAM,
      from: { id: BOB.id, is_bot: false, first_name: "Bob" },
    };
    await h.update({ edited_message: { ...base, text: "v2", edit_date: nowSeconds() } });
    await h.update({ message: { ...base, text: "v1" } });
    const row = h.db.raw
      .query("SELECT text FROM messages WHERE chat_id = ? AND message_id = 60")
      .get(TEAM.id) as { text: string };
    expect(row.text).toBe("v2");
  });

  it("a revoke racing a /connect never takes the newcomer's grant", async () => {
    await h.addBot(TEAM, ALICE);
    h.markConnected(BOB);
    await Promise.all([
      h.update({
        callback_query: { id: "r", from: { ...ALICE, is_bot: false }, data: `rv:${TEAM.id}` },
      }),
      h.say(TEAM, BOB, "/connect"),
    ]);
    expect(
      count("SELECT COUNT(*) AS n FROM grants WHERE chat_id = ? AND user_id = ?", TEAM.id, BOB.id),
    ).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM chats WHERE chat_id = ?", TEAM.id)).toBe(1);
  });

  it("revokeGrant purges history only when no grant is left at commit", async () => {
    const store = new Store(h.db.asD1());
    await h.addBot(TEAM, ALICE);
    h.markConnected(BOB);
    await h.say(TEAM, BOB, "/connect");
    await h.say(TEAM, BOB, "hello");
    expect(await store.revokeGrant(ALICE.id, TEAM.id)).toBe(false);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?", TEAM.id)).toBeGreaterThan(
      0,
    );
    expect(await store.revokeGrant(BOB.id, TEAM.id)).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?", TEAM.id)).toBe(0);
  });

  it("messages for a chat being forgotten are not written afterwards", async () => {
    await h.addBot(TEAM, ALICE);
    await h.update({
      callback_query: { id: "r", from: { ...ALICE, is_bot: false }, data: `rv:${TEAM.id}` },
    });
    await h.say(TEAM, BOB, "too late");
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?", TEAM.id)).toBe(0);
  });
});

describe("chat lifecycle", () => {
  it("leaves a group added by someone outside the allowlist", async () => {
    h.restore();
    h = new Harness({ ALLOWED_USER_IDS: String(ALICE.id) });
    await h.addBot(TEAM, BOB);
    expect(h.telegram.called("leaveChat")).toHaveLength(1);
    expect(count("SELECT COUNT(*) AS n FROM grants")).toBe(0);
  });

  it("forgets everything when the bot is removed", async () => {
    await h.addBot(TEAM, ALICE);
    await h.say(TEAM, BOB, "bye");
    await h.update({
      my_chat_member: {
        chat: TEAM,
        from: { ...ALICE, is_bot: false },
        date: nowSeconds(),
        old_chat_member: { status: "member", user: { id: 123456, is_bot: true, first_name: "T" } },
        new_chat_member: { status: "kicked", user: { id: 123456, is_bot: true, first_name: "T" } },
      },
    });
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM grants")).toBe(0);
  });

  it("carries a group over when it becomes a supergroup", async () => {
    const OLD = { id: -4001, title: "Old", type: "group" };
    await h.addBot(OLD, ALICE);
    await h.say(OLD, BOB, "before");
    await h.say(OLD, ALICE, "", { text: undefined, migrate_to_chat_id: -1004001 });
    expect(count("SELECT COUNT(*) AS n FROM grants WHERE chat_id = -1004001")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE chat_id = -1004001")).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE chat_id = -4001")).toBe(0);
  });

  it("drops a grant once getChatMember says the user left", async () => {
    await h.addBot(TEAM, ALICE);
    await h.say(TEAM, ALICE, "/start");
    h.db.raw.exec(`UPDATE grants SET verified_at = 0`);
    h.telegram.members.set(`${TEAM.id}:${ALICE.id}`, "left");
    const alice = (await h.connect(ALICE)).access_token;
    const chats = await h.tool(alice, "list_chats");
    expect(chats.text).not.toContain("Team");
    expect(count("SELECT COUNT(*) AS n FROM grants")).toBe(0);
  });

  it("the daily purge removes what is past retention", async () => {
    await h.addBot(TEAM, ALICE);
    await h.say(TEAM, BOB, "fresh");
    await h.say(TEAM, BOB, "stale", { date: nowSeconds() - 15 * 86400 });
    const store = new Store(h.db.asD1());
    expect(await store.purge(nowSeconds() - 14 * 86400)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(1);
  });
});

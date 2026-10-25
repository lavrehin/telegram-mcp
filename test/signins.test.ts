import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { Harness } from "./harness";

const ALICE = { id: 111, first_name: "Alice", username: "alice", language_code: "en" };
const dm = (user: { id: number }) => ({ id: user.id, type: "private" });

type Button = { text: string; callback_data?: string };

let h: Harness;
beforeEach(async () => {
  h = new Harness();
  await h.ensureSchema();
});
afterEach(() => h.restore());

function buttons(markup: unknown): Button[] {
  return ((markup as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? []).flat();
}

async function press(data: string) {
  const response = await h.update({
    callback_query: {
      id: "q",
      from: { ...ALICE, is_bot: false },
      data,
      message: { message_id: 77, date: 1, chat: dm(ALICE) },
    },
  });
  const answer = await response.json<{ text?: string }>();
  return { screen: h.telegram.called("editMessageText").at(-1)?.params, answer };
}

/** Whether the MCP endpoint still takes this access token. */
const works = async (token: string) =>
  (await h.mcp(token, "tools/call", { name: "list_chats", arguments: {} })).status === 200;

describe("sign-ins", () => {
  it("lists each sign-in with the client it went to", async () => {
    await h.connect(ALICE);
    await h.connect(ALICE, { redirect: "http://127.0.0.1:3118/callback", name: "Claude Code" });
    const { screen } = await press("m:si");
    const text = String(screen!.text);
    expect(text).toContain("<b>Claude</b> —");
    expect(text).toContain("Claude Code (on this computer)");
    const outs = buttons(screen!.reply_markup).filter((b) => b.callback_data?.startsWith("m:sx:"));
    expect(outs).toHaveLength(2);
  });

  it("signing one out stops its tokens at once and leaves the other", async () => {
    const first = await h.connect(ALICE);
    const second = await h.connect(ALICE, { redirect: "http://localhost:9/cb", name: "Codex" });
    const { screen } = await press("m:si");
    const ids = buttons(screen!.reply_markup)
      .map((b) => b.callback_data!)
      .filter((d) => d.startsWith("m:sx:"));
    const row = h.db.raw
      .query("SELECT id FROM refresh_sessions WHERE client_name = 'Claude'")
      .get() as { id: string };
    const { answer } = await press(`m:sx:${row.id}`);
    expect(answer.text).toBeTruthy();
    expect(ids).toContain(`m:sx:${row.id}`);

    expect(await works(first.access_token)).toBe(false);
    expect((await h.refresh(first.refresh_token)).status).toBe(400);
    expect(await works(second.access_token)).toBe(true);
  });

  it("cannot sign out someone else's sign-in", async () => {
    const bob = await h.connect({ id: 222, first_name: "Bob" });
    await h.connect(ALICE);
    const row = h.db.raw.query("SELECT id FROM refresh_sessions WHERE user_id = 222").get() as {
      id: string;
    };
    await press(`m:sx:${row.id}`);
    expect(await works(bob.access_token)).toBe(true);
    const rows = h.db.raw.query("SELECT COUNT(*) AS n FROM refresh_sessions").get() as {
      n: number;
    };
    expect(rows.n).toBe(2);
  });

  it("signing out everywhere asks first, then ends every sign-in", async () => {
    const one = await h.connect(ALICE);
    const confirm = await press("m:out");
    expect(buttons(confirm.screen!.reply_markup).map((b) => b.callback_data)).toEqual([
      "m:outyes",
      "m:si",
    ]);
    expect(await works(one.access_token)).toBe(true);
    const done = await press("m:outyes");
    expect(await works(one.access_token)).toBe(false);
    expect(String(done.screen!.text)).not.toContain("<b>Claude</b>");
  });

  it("keeps old tokens without a sign-in id working, and lists them once refreshed", async () => {
    const tokens = await h.connect(ALICE);
    // As if issued before sign-ins were recorded: no row, and an access token without `s`.
    h.db.raw.exec("DELETE FROM refresh_sessions");
    const { sign } = await import("../src/crypto");
    const old = await sign(await h.signingKey(), "access", { u: ALICE.id, v: 0 }, 3600);
    expect(await works(old)).toBe(true);
    const refreshed = await h.refresh(tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    const { screen } = await press("m:si");
    expect(String(screen!.text)).toContain("Unknown client");
  });

  it("signs out a sign-in from before rotation, whose id is a token hash", async () => {
    const tokens = await h.connect(ALICE);
    const long = "a".repeat(43);
    h.db.raw.exec(`UPDATE refresh_sessions SET id = '${long}'`);
    expect(await works(tokens.access_token)).toBe(false); // its row now has another id
    const { answer } = await press(`m:sx:${long}`);
    expect(answer.text).toBe("Signed out.");
    const row = h.db.raw.query("SELECT revoked FROM refresh_sessions").get() as { revoked: number };
    expect(row.revoked).toBe(1);
  });

  it("keeps the client name and sign-in date through refreshes", async () => {
    const tokens = await h.connect(ALICE);
    const before = h.db.raw.query("SELECT client_name, created_at FROM refresh_sessions").get();
    expect((await h.refresh(tokens.refresh_token)).status).toBe(200);
    const after = h.db.raw.query("SELECT client_name, created_at FROM refresh_sessions").get();
    expect(after).toEqual(before);
  });
});

/** Cases raised in review: isolation between users, OAuth misuse, files, markup. */

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";

import { nowSeconds, sha256Base64Url, sign } from "../src/crypto";
import { markdownToHtml } from "../src/markdown";
import { safeFilename } from "../src/tools/read";
import { consentLink, Harness } from "./harness";

const ALICE = { id: 111, first_name: "Alice", username: "alice" };
const BOB = { id: 222, first_name: "Bob", username: "bob" };
const dm = (user: { id: number }) => ({ id: user.id, type: "private" });
const TEAM = { id: -1007770001, title: "Team", type: "supergroup" };

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(() => h.restore());

describe("isolation between users", () => {
  it("one user cannot read or post to another's private chat or group", async () => {
    await h.say(dm(ALICE), ALICE, "/start");
    await h.say(dm(ALICE), ALICE, "alice secret");
    await h.addBot(TEAM, ALICE);
    const bob = (await h.connect(BOB)).access_token;

    for (const chat of [ALICE.id, String(ALICE.id), TEAM.id, "Team"]) {
      const read = await h.tool(bob, "get_recent_messages", { chat });
      expect(read.text).not.toContain("alice secret");
      const post = await h.tool(bob, "send_message", { chat, text: "x" });
      if (chat !== String(ALICE.id) && chat !== ALICE.id) expect(post.isError).toBe(true);
    }
    // Bob's "me" is Bob's own chat, never Alice's.
    await h.tool(bob, "send_message", { text: "hi" });
    expect(h.telegram.called("sendMessage").at(-1)!.params.chat_id).toBe(BOB.id);
  });

  it("in a shared group, one user's assistant cannot edit or delete the other's messages", async () => {
    await h.addBot(TEAM, ALICE);
    h.markConnected(BOB);
    await h.say(TEAM, BOB, "/connect");
    const alice = (await h.connect(ALICE)).access_token;
    const bob = (await h.connect(BOB)).access_token;
    const sent = await h.tool(alice, "send_message", { chat: TEAM.id, text: "alice's note" });
    const id = Number(/#(\d+)/.exec(sent.text)![1]);

    expect(
      (await h.tool(bob, "edit_message", { chat: TEAM.id, message_id: id, text: "x" })).isError,
    ).toBe(true);
    expect((await h.tool(bob, "delete_message", { chat: TEAM.id, message_id: id })).isError).toBe(
      true,
    );
    expect(
      (await h.tool(alice, "edit_message", { chat: TEAM.id, message_id: id, text: "fixed" }))
        .isError,
    ).toBe(false);
  });

  it("a revoke button pressed by someone without the grant changes nothing", async () => {
    await h.addBot(TEAM, ALICE);
    await h.update({
      callback_query: { id: "x", from: { ...BOB, is_bot: false }, data: `rv:${TEAM.id}` },
    });
    const grants = h.db.raw.query("SELECT COUNT(*) AS n FROM grants").get() as { n: number };
    expect(grants.n).toBe(1);
  });
});

describe("refresh rotation", () => {
  afterEach(() => setSystemTime());

  it("hands out a new refresh token each time and retires the old one", async () => {
    const first = await h.connect(ALICE);
    const second = await h.refresh(first.refresh_token);
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);
    expect((await h.mcp(second.body.access_token!, "tools/list")).status).toBe(200);

    const third = await h.refresh(second.body.refresh_token!);
    expect(third.status).toBe(200);
    expect((await h.refresh(third.body.refresh_token!)).status).toBe(200);
  });

  it("survives a retry minutes after a lost response, until the newer token is used", async () => {
    const first = await h.connect(ALICE);
    const lost = await h.refresh(first.refresh_token);
    expect(lost.status).toBe(200);
    setSystemTime(new Date(Date.now() + 5 * 60_000));
    const retried = await h.refresh(first.refresh_token);
    expect(retried.status).toBe(200);
    const next = await h.refresh(retried.body.refresh_token!);
    expect(next.status).toBe(200);
    // The newer token has been used: the old one is a copy now.
    expect((await h.refresh(first.refresh_token)).status).toBe(400);
    expect((await h.refresh(next.body.refresh_token!)).status).toBe(400);
  });

  it("stops rotated tokens on /disconnect", async () => {
    await h.say(dm(ALICE), ALICE, "/start");
    const first = await h.connect(ALICE);
    const second = await h.refresh(first.refresh_token);
    await h.say(dm(ALICE), ALICE, "/disconnect");
    expect((await h.refresh(second.body.refresh_token!)).status).toBe(400);
  });

  it("answers a doubled refresh within the grace with the current token", async () => {
    const first = await h.connect(ALICE);
    const a = await h.refresh(first.refresh_token);
    const b = await h.refresh(first.refresh_token);
    expect(b.status).toBe(200);
    expect((await h.refresh(b.body.refresh_token!)).status).toBe(200);
    expect(a.status).toBe(200);
  });

  it("revokes the whole session when a retired token comes back later", async () => {
    const first = await h.connect(ALICE);
    const second = await h.refresh(first.refresh_token);
    setSystemTime(new Date(Date.now() + 11 * 60_000));

    expect((await h.refresh(first.refresh_token)).status).toBe(400);
    expect((await h.refresh(second.body.refresh_token!)).status).toBe(400);

    // Other sign-ins of the same user are untouched.
    const other = await h.connect(ALICE);
    expect((await h.refresh(other.refresh_token)).status).toBe(200);
  });

  it("rotates a token from before rotation once, then treats it as retired", async () => {
    await h.connect(ALICE);
    const legacy = await sign(await h.signingKey(), "refresh", { u: ALICE.id, v: 0 }, 3600);
    const next = await h.refresh(legacy);
    expect(next.status).toBe(200);
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    expect((await h.refresh(legacy)).status).toBe(400);
    expect((await h.refresh(next.body.refresh_token!)).status).toBe(400);
  });
});

describe("oauth misuse", () => {
  async function start() {
    const redirect = "https://claude.ai/api/mcp/auth_callback";
    const reg = await h.fetch("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirect] }),
    });
    const { client_id } = await reg.json<{ client_id: string }>();
    const verifier = "v".repeat(50);
    const auth = await h.fetch(
      `/authorize?${new URLSearchParams({
        response_type: "code",
        client_id,
        redirect_uri: redirect,
        code_challenge: await sha256Base64Url(verifier),
        code_challenge_method: "S256",
      }).toString()}`,
    );
    const back = await consentLink(auth);
    const done = await h.fetch(back.returnTo, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: back.cookie },
      body: JSON.stringify(await h.loginPayload(ALICE)),
    });
    const code = new URL((await done.json<{ redirect: string }>()).redirect).searchParams.get(
      "code",
    )!;
    return { client_id, redirect, verifier, code };
  }

  const token = (form: Record<string, string>) =>
    h.fetch("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });

  it("refuses a wrong PKCE verifier, a different redirect and a different client", async () => {
    const flow = await start();
    const base = {
      grant_type: "authorization_code",
      code: flow.code,
      redirect_uri: flow.redirect,
      client_id: flow.client_id,
    };
    expect((await token({ ...base, code_verifier: "w".repeat(50) })).status).toBe(400);
    expect(
      (
        await token({
          ...base,
          code_verifier: flow.verifier,
          redirect_uri: "https://claude.ai/other",
        })
      ).status,
    ).toBe(400);
    expect(
      (await token({ ...base, code_verifier: flow.verifier, client_id: "someone-else" })).status,
    ).toBe(400);
    expect((await token({ ...base, code_verifier: flow.verifier })).status).toBe(200);
  });

  it("refuses foreign redirect URIs at registration and authorization", async () => {
    const reg = await h.fetch("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }),
    });
    expect(reg.status).toBe(400);
    const auth = await h.fetch(
      "/authorize?response_type=code&client_id=x&redirect_uri=https%3A%2F%2Fclaude.ai.evil.com%2Fcb&code_challenge=abc",
    );
    expect(auth.status).toBe(400);
  });

  it("asks before Telegram, naming who gets access", async () => {
    const auth = await h.fetch(
      `/authorize?${new URLSearchParams({ response_type: "code", client_id: "c", redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect", code_challenge: "abc" }).toString()}`,
    );
    expect(auth.status).toBe(200);
    expect(auth.headers.get("x-frame-options")).toBe("DENY");
    const html = await auth.clone().text();
    expect(html).toContain("Connect ChatGPT to @test_mcp_bot?");
    expect(html).toContain("error=access_denied");
    const { telegram, returnTo, cookie } = await consentLink(auth);
    expect(telegram.host).toBe("oauth.telegram.org");
    expect(cookie).toStartWith("__Host-tg-");
    expect(auth.headers.get("set-cookie")).toContain("HttpOnly");

    // The Telegram link copied out of the page and opened in another browser.
    const login = JSON.stringify(await h.loginPayload(ALICE));
    const post = { method: "POST", headers: { "content-type": "application/json" }, body: login };
    expect((await h.fetch(returnTo, post)).status).toBe(403);
    const other = { ...post, headers: { ...post.headers, cookie: "__Host-tg-someoneelse=1" } };
    expect((await h.fetch(returnTo, other)).status).toBe(403);
    expect((await h.fetch(returnTo)).status).toBe(403);
  });

  it("refuses a forged or stale login", async () => {
    const auth = await h.fetch(
      `/authorize?${new URLSearchParams({ response_type: "code", client_id: "c", redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: "abc" }).toString()}`,
    );
    const back = await consentLink(auth);
    const forged = { ...(await h.loginPayload(ALICE)), id: BOB.id };
    const stale = await h.loginPayload(ALICE, nowSeconds() - 3600);
    for (const body of [forged, stale]) {
      const response = await h.fetch(back.returnTo, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: back.cookie },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });
});

describe("files", () => {
  async function uploadPath() {
    await h.say(dm(ALICE), ALICE, "/start");
    const alice = (await h.connect(ALICE)).access_token;
    const result = await h.tool(alice, "create_upload_url", { filename: "a.bin" });
    return new URL(/https:\/\/\S+\/upload\/\S+/.exec(result.text)![0]).pathname;
  }

  it("refuses an upload with no length, and one past Telegram's limit, without spending the link", async () => {
    const path = await uploadPath();
    expect((await h.fetch(path, { method: "PUT", body: new Uint8Array([1]) })).status).toBe(411);
    expect(
      (
        await h.fetch(path, {
          method: "PUT",
          headers: { "content-length": String(60 * 1024 * 1024) },
          body: new Uint8Array([1]),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await h.fetch(path, {
          method: "PUT",
          headers: { "content-length": "2" },
          body: new Uint8Array([1, 2]),
        })
      ).status,
    ).toBe(200);
  });

  it("an upload link dies with /disconnect", async () => {
    const path = await uploadPath();
    await h.say(dm(ALICE), ALICE, "/disconnect");
    expect(
      (
        await h.fetch(path, {
          method: "PUT",
          headers: { "content-length": "1" },
          body: new Uint8Array([1]),
        })
      ).status,
    ).toBe(403);
  });

  it("keeps a hostile file name out of the suggested shell command", () => {
    expect(safeFilename("../../.bashrc")).toBe("bashrc");
    expect(safeFilename("-rf ~")).toBe("rf__");
    expect(safeFilename("отчёт.pdf")).toBe("_____.pdf");
    expect(safeFilename("")).toBe("file");
  });
});

describe("login page", () => {
  it("renders loading, success and failure states with the fallback widget", async () => {
    const auth = await h.fetch(
      `/authorize?${new URLSearchParams({ response_type: "code", client_id: "c", redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: "abc" }).toString()}`,
    );
    const back = await consentLink(auth);
    const html = await (await h.fetch(back.returnTo, { headers: { cookie: back.cookie } })).text();
    for (const id of [
      'id="loading"',
      'id="done"',
      'id="failed"',
      "telegram-widget.js",
      "@test_mcp_bot",
    ]) {
      expect(html).toContain(id);
    }
    expect(html).not.toContain("innerHTML");
  });
});

describe("markdown nesting", () => {
  it("never emits crossed tags", () => {
    for (const input of [
      "**a _b** c_",
      "~~a **b~~ c**",
      "||sp *it|| x*",
      "**unclosed _x",
      "_a **b_ c**",
    ]) {
      const html = markdownToHtml(input);
      const stack: string[] = [];
      for (const [, closing, name] of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
        if (closing) expect(stack.pop()).toBe(name);
        else stack.push(name);
      }
      expect(stack).toEqual([]);
    }
  });
});

describe("windowed reads", () => {
  it("search with since only returns the window, and recent respects it", async () => {
    await h.addBot(TEAM, ALICE);
    await h.say(TEAM, BOB, "deploy old", { date: nowSeconds() - 5 * 86400 });
    await h.say(TEAM, BOB, "deploy new");
    const alice = (await h.connect(ALICE)).access_token;
    const recent = await h.tool(alice, "search_messages", { query: "deploy", since: "2d" });
    expect(recent.text).toContain("deploy new");
    expect(recent.text).not.toContain("deploy old");
    // Without since only the last day is searched, and the answer says so.
    const fallback = await h.tool(alice, "search_messages", { query: "deploy" });
    expect(fallback.text).toContain("default: last 1d");
    expect(fallback.text).not.toContain("deploy old");
    const wide = await h.tool(alice, "search_messages", { query: "deploy", since: "7d" });
    expect(wide.text).toContain("deploy old");
    // Asking past retention is clamped, and said.
    const tooFar = await h.tool(alice, "search_messages", { query: "deploy", since: "30d" });
    expect(tooFar.text).toContain("nothing older than 14 days is kept");
    const marks = h.db.raw
      .query("SELECT COUNT(*) AS n FROM day_marks WHERE chat_id = ?")
      .get(TEAM.id) as { n: number };
    expect(marks.n).toBe(2);
  });
});

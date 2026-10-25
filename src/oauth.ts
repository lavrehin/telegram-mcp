/**
 * OAuth 2.1 for the connector, with Telegram Login as the identity provider.
 *
 *   /register        dynamic client registration — so neither Claude nor
 *                    ChatGPT asks for a client id or secret
 *   /authorize       a consent page naming the assistant, then Telegram's
 *                    own login page
 *   /auth/telegram   where Telegram sends the user back; verifies the login
 *                    and returns to the client with a code
 *   /token           code (+ PKCE verifier) → access and refresh tokens
 *
 * Clients, codes and tokens are all signed blobs (see src/crypto.ts), so the
 * database is touched only to record the user, check their token version and
 * rotate refresh tokens. Revocation is the token version — /disconnect in the
 * bot bumps it, and every token minted before stops working.
 *
 * Refresh tokens rotate: each use returns a new one and retires the old. A
 * sign-in is a session with a current generation; presenting an older one
 * means two parties hold the session's tokens — one of them a thief — so the
 * whole session is revoked. A client that sends one refresh twice at once
 * (retries, two tabs) gets the current token back within a short grace.
 *
 * Telegram Login needs the Worker's domain set on the bot: @BotFather →
 * /setdomain. Without it Telegram shows "Bot domain invalid".
 */

import {
  OAuthError,
  OAuthErrorCode,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
  type AuthInfo,
  type AuthMetadataOptions,
} from "@modelcontextprotocol/server";

import { escapeHtml } from "./bot/texts";
import { nowSeconds, randomId, sha256Base64Url, sign, verify } from "./crypto";
import { isAllowed, type Config, type Env } from "./env";
import { allow, clientIp, RETRY_AFTER_HEADERS } from "./limits";
import type { Store } from "./store";
import { verifyLogin, type LoginUser } from "./telegram/login";

const SCOPE = "telegram";

const STATE_TTL = 15 * 60;
const CODE_TTL = 5 * 60;
const ACCESS_TTL = 24 * 60 * 60;
const REFRESH_TTL = 90 * 24 * 60 * 60;
/**
 * How long a just-retired refresh token still gets the current one back: a
 * retry after a lost response, or two refreshes at once. Only while the
 * newer token has not been used itself.
 */
const ROTATION_GRACE = 10 * 60;

/**
 * The exact callbacks of Claude and ChatGPT. Any other page on those sites —
 * or one of their subdomains — could end up in someone else's hands, and a
 * code sent there would be theirs to redeem: they started the flow, so they
 * hold the PKCE verifier. Loopback (Codex, Claude Code and other local
 * clients) is allowed on any port and path: only the machine itself listens.
 */
const CALLBACKS: Record<string, string> = {
  "https://claude.ai/api/mcp/auth_callback": "Claude",
  "https://claude.com/api/mcp/auth_callback": "Claude",
  "https://chatgpt.com/connector_platform_oauth_redirect": "ChatGPT",
};

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

export interface OAuthDeps {
  env: Env;
  config: Config;
  store: Store;
  botUsername: string;
}

interface ClientBlob {
  r: string[];
  n?: string;
}
interface StateBlob {
  r: string; // redirect_uri
  s?: string; // client state
  c: string; // PKCE challenge
  /** SHA-256 of the client_id the flow started with. */
  cid: string;
  /** Names the cookie the consent page set, so only that browser can finish the flow. */
  n: string;
  /** Who the sign-in goes to, for the user's list of sign-ins. */
  cn?: string;
}
interface CodeBlob extends StateBlob {
  u: number;
}
interface TokenBlob {
  u: number;
  v: number;
  /** The sign-in (session) id, so ending one sign-in stops its access tokens at once. */
  s?: string;
}
interface RefreshBlob extends TokenBlob {
  /** Absent on refresh tokens from before rotation: the token's hash stands in. */
  /** Generation within the session; absent means 0. */
  g?: number;
}
interface RefreshSession {
  id: string;
  generation: number;
}

// --- helpers ---------------------------------------------------------------

/** Public origin, honouring the proxy header Cloudflare sets. */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto) url.protocol = `${forwardedProto.split(",")[0].trim()}:`;
  return url.origin;
}

function publicMcpUrl(request: Request): URL {
  return new URL(`${publicOrigin(request)}/`);
}

/**
 * Who a code for `target` goes to — "Claude", "ChatGPT", or an app on this
 * computer — or null when codes may not go there at all. Callbacks must match
 * exactly as written, so the string stored and redirected to is the one
 * checked.
 */
function redirectOwner(target: string): string | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (LOOPBACK.includes(url.hostname)) {
    return url.protocol === "http:" || url.protocol === "https:"
      ? `an app on this computer (${url.host})`
      : null;
  }
  return Object.hasOwn(CALLBACKS, target) ? CALLBACKS[target] : null;
}

/**
 * How the sign-in is listed: the verified callback's owner, or for an app on
 * this computer the name it registered with — its own claim, but only the
 * user's machine can receive that code anyway.
 */
async function clientName(
  deps: OAuthDeps,
  clientId: string,
  redirectUri: string,
): Promise<string | undefined> {
  if (Object.hasOwn(CALLBACKS, redirectUri)) return CALLBACKS[redirectUri];
  const client = await verify<ClientBlob>(deps.config.signingKey, "client", clientId);
  return client?.n ? `${client.n} (on this computer)` : "An app on this computer";
}

/** Codes may only go to Claude's or ChatGPT's own callback, or to loopback. */
export function allowedRedirect(target: string): boolean {
  return redirectOwner(target) !== null;
}

function metadataOptions(mcpUrl: URL): AuthMetadataOptions {
  const issuer = mcpUrl.origin;
  return {
    resourceServerUrl: mcpUrl,
    resourceName: "Telegram",
    scopesSupported: [SCOPE],
    dangerouslyAllowInsecureIssuerUrl: mcpUrl.protocol !== "https:",
    oauthMetadata: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: [SCOPE],
    },
  };
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
};

function jsonResponse(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

function oauthError(error: string, description: string, status = 400, extra: HeadersInit = {}) {
  return jsonResponse({ error, error_description: description }, status, extra);
}

const PAGE_STYLE = `
  :root { color-scheme: light; --fg: #111; --muted: #777; --line: #eaeaea; --bad: #c62828; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 16px;
         background: #fff; color: var(--fg); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width: 100%; max-width: 360px; text-align: center; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 6px; }
  p { color: var(--muted); margin: 0 0 14px; }
  .state[hidden] { display: none; }
  .spinner { width: 18px; height: 18px; margin: 14px auto; border-radius: 50%; border: 2px solid var(--line);
             border-top-color: var(--fg); animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error { color: var(--bad); margin: 0 0 18px; overflow-wrap: anywhere; }
  a { color: var(--fg); }
  a.button { display: inline-block; color: #fff; background: var(--fg); text-decoration: none; padding: 9px 18px;
             border-radius: 8px; font-weight: 500; }
  .widget { margin-top: 18px; min-height: 40px; }
  .rows { text-align: left; margin: 18px 0 0; }
  .rows div { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); }
  .rows div span:first-child { color: var(--muted); }
  .rows div span:last-child { text-align: right; overflow-wrap: anywhere; }
  code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  footer { margin-top: 32px; font-size: 13px; color: var(--muted); }
  footer a { color: inherit; }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }`;

export function page(title: string, body: string, status = 200, script = ""): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>
<body><main>${body}</main>${script}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
      },
    },
  );
}

function setupError(message: string, status = 400): Response {
  return page(
    "Can't connect",
    `<h1>Can't connect</h1><p class="error" role="alert">${escapeHtml(message)}</p>
<p>Start connecting again from your assistant's settings.</p>`,
    status,
  );
}

/** Credentials from the request body or an HTTP Basic header. */
function readClientId(form: URLSearchParams, request: Request): string {
  const header = request.headers.get("authorization");
  if (header?.toLowerCase().startsWith("basic ")) {
    try {
      return decodeURIComponent(atob(header.slice(6)).split(":")[0]);
    } catch {
      // Fall through to the form value.
    }
  }
  return form.get("client_id") ?? "";
}

// --- endpoints -------------------------------------------------------------

async function handleRegister(request: Request, deps: OAuthDeps): Promise<Response> {
  if (request.method !== "POST") return oauthError("invalid_request", "POST only.", 405);
  let body: { redirect_uris?: unknown; client_name?: unknown };
  try {
    body = await request.json<typeof body>();
  } catch {
    return oauthError("invalid_client_metadata", "Body must be JSON.");
  }

  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(allowedRedirect)) {
    return oauthError(
      "invalid_redirect_uri",
      "Only Claude's and ChatGPT's own callbacks, and loopback, are allowed.",
    );
  }
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 80) : undefined;
  const clientId = await sign<ClientBlob>(deps.config.signingKey, "client", { r: uris, n: name });

  return jsonResponse(
    {
      client_id: clientId,
      client_id_issued_at: nowSeconds(),
      redirect_uris: uris,
      client_name: name,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPE,
    },
    201,
  );
}

/** A registered client may only use its own redirect URIs; any other client id gets the allowlist. */
async function clientAllows(deps: OAuthDeps, clientId: string, redirectUri: string) {
  const client = await verify<ClientBlob>(deps.config.signingKey, "client", clientId);
  if (client) return client.r.includes(redirectUri);
  return allowedRedirect(redirectUri);
}

function telegramLoginUrl(config: Config, origin: string, state: string): string {
  const url = new URL("https://oauth.telegram.org/auth");
  url.searchParams.set("bot_id", String(config.botId));
  url.searchParams.set("origin", origin);
  url.searchParams.set("request_access", "write");
  url.searchParams.set("return_to", `${origin}/auth/telegram?st=${encodeURIComponent(state)}`);
  return url.toString();
}

async function handleAuthorize(request: Request, deps: OAuthDeps): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const redirectUri = params.get("redirect_uri");
  const clientId = params.get("client_id") ?? "";

  if (!redirectUri) return setupError("Missing redirect_uri.");
  if (!allowedRedirect(redirectUri) || !(await clientAllows(deps, clientId, redirectUri))) {
    return setupError(`redirect_uri ${redirectUri} is not allowed for this client.`);
  }

  const back = (error: string) => {
    const target = new URL(redirectUri);
    target.searchParams.set("error", error);
    const state = params.get("state");
    if (state) target.searchParams.set("state", state);
    return Response.redirect(target.toString(), 302);
  };

  if (params.get("response_type") !== "code") return back("unsupported_response_type");
  const challenge = params.get("code_challenge");
  if (!challenge || (params.get("code_challenge_method") ?? "S256") !== "S256") {
    return back("invalid_request");
  }

  const nonce = randomId();
  const state = await sign<StateBlob>(
    deps.config.signingKey,
    "state",
    {
      r: redirectUri,
      s: params.get("state") ?? undefined,
      c: challenge,
      cid: await sha256Base64Url(clientId),
      n: nonce,
      cn: await clientName(deps, clientId, redirectUri),
    },
    STATE_TTL,
  );
  const response = consentPage(
    deps,
    redirectUri,
    telegramLoginUrl(deps.config, publicOrigin(request), state),
    back("access_denied").headers.get("location")!,
  );
  response.headers.append("set-cookie", consentCookie(nonce, STATE_TTL));
  return response;
}

/**
 * One click between /authorize and Telegram. Without it, a link someone else
 * started — their client, their PKCE — would hand them access after a single
 * "Accept" on Telegram's page, which names the bot but not who gets it. The
 * assistant is named after where the code goes, not the client's own name,
 * which anyone registering a client may choose.
 *
 * The page also sets a cookie the return from Telegram must carry, so the
 * Telegram link on it cannot be copied and sent to someone else: their
 * browser never saw this page.
 */
function consentPage(
  deps: OAuthDeps,
  redirectUri: string,
  telegramUrl: string,
  cancelUrl: string,
): Response {
  const owner = escapeHtml(redirectOwner(redirectUri) ?? redirectUri);
  const Owner = owner.charAt(0).toUpperCase() + owner.slice(1);
  const bot = escapeHtml(deps.botUsername);
  return page(
    "Connect Telegram",
    `<h1>Connect ${owner} to @${bot}?</h1>
<p>${Owner} will read the messages @${bot} receives — your private chat with it and the groups you
connect — and send messages as the bot.</p>
<p>Continue only if you started connecting it yourself, just now.</p>
<a class="button" id="continue" href="${escapeHtml(telegramUrl)}">Continue with Telegram</a>
<p><a id="cancel" href="${escapeHtml(cancelUrl)}">Cancel</a></p>
<footer><a href="https://t.me/${bot}">@${bot}</a></footer>`,
  );
}

/**
 * One cookie per flow, so two connections started side by side do not clash.
 * Lax still rides along on Telegram's top-level redirect back.
 */
function consentCookie(nonce: string, maxAge: number): string {
  return `__Host-tg-${nonce}=1; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function hasConsentCookie(request: Request, nonce: string): boolean {
  const cookies = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim());
  return cookies.includes(`__Host-tg-${nonce}=1`);
}

/**
 * Where Telegram sends the user back. Three shapes arrive here:
 *   - the full-page flow puts the login in the URL fragment (#tgAuthResult=…),
 *     which only the browser can read — so a tiny page reads it and POSTs it;
 *   - the login widget, as a fallback, redirects with the fields in the query;
 *   - that page's POST.
 */
async function handleTelegramReturn(request: Request, deps: OAuthDeps): Promise<Response> {
  const url = new URL(request.url);
  const stateBlob = url.searchParams.get("st") ?? "";
  const state = await verify<StateBlob>(deps.config.signingKey, "state", stateBlob);
  if (!state) {
    return setupError("This sign-in link has expired. Start connecting again from your assistant.");
  }
  if (!hasConsentCookie(request, state.n)) {
    return setupError(
      "This sign-in was not started in this browser. Start connecting from your assistant here.",
      403,
    );
  }
  const finished = { "set-cookie": consentCookie(state.n, 0) };

  if (request.method === "POST") {
    let login: Record<string, unknown> | null = null;
    try {
      login = await request.json<Record<string, unknown> | null>();
    } catch {
      // Treated as a failed login below.
    }
    if (!login || typeof login !== "object") {
      return jsonResponse({ error: "Telegram did not return a login." }, 400);
    }
    const outcome = await completeLogin(deps, state, login);
    return typeof outcome === "string"
      ? jsonResponse({ redirect: outcome }, 200, finished)
      : jsonResponse({ error: outcome.error }, 400);
  }

  if (url.searchParams.has("hash")) {
    const fields = Object.fromEntries([...url.searchParams].filter(([key]) => key !== "st"));
    const outcome = await completeLogin(deps, state, fields);
    return typeof outcome === "string"
      ? new Response(null, { status: 302, headers: { location: outcome, ...finished } })
      : setupError(outcome.error, 403);
  }

  return loginPage(deps, request, stateBlob);
}

function loginPage(deps: OAuthDeps, request: Request, stateBlob: string): Response {
  const origin = publicOrigin(request);
  const returnUrl = `${origin}/auth/telegram?st=${encodeURIComponent(stateBlob)}`;
  const retry = telegramLoginUrl(deps.config, origin, stateBlob);
  const bot = escapeHtml(deps.botUsername);

  // Every value from Telegram or the server goes in through textContent, never as HTML.
  const script = `<script>
(function () {
  function $(id) { return document.getElementById(id); }
  function show(id) {
    ["loading", "done", "failed"].forEach(function (s) { $(s).hidden = s !== id; });
  }
  function fail(message) {
    $("error").textContent = message;
    show("failed");
    document.title = "Sign-in failed";
  }

  var match = /tgAuthResult=([^&]+)/.exec(location.hash);
  history.replaceState(null, "", location.pathname + location.search);
  if (!match) { fail("Telegram did not finish the sign-in. Try again."); return; }

  var data = null;
  try {
    var b64 = decodeURIComponent(match[1]).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    data = JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch (e) { data = null; }
  if (!data || typeof data !== "object") { fail("Sign-in was cancelled."); return; }

  fetch(location.href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) })
    .then(function (r) { return r.json(); })
    .then(function (body) {
      if (!body.redirect) { fail(body.error || "Sign-in failed."); return; }
      var name = [data.first_name, data.last_name].filter(Boolean).join(" ") || "Telegram user";
      $("who").textContent = "Signed in as " + name + (data.username ? " (@" + data.username + ")" : "") + ".";
      var host = "your assistant";
      try { host = new URL(body.redirect).hostname.replace(/^www\\./, ""); } catch (e) {}
      $("back").textContent = "Taking you back to " + host + "…";
      $("manual").href = body.redirect;
      show("done");
      document.title = "Connected";
      setTimeout(function () { location.replace(body.redirect); }, 900);
    })
    .catch(function () { fail("Network error. Check your connection and try again."); });
})();
</script>`;

  return page(
    "Connecting Telegram…",
    `<section id="loading" class="state">
  <h1>Connecting Telegram</h1>
  <div class="spinner" role="status" aria-label="Loading"></div>
</section>
<section id="done" class="state" hidden>
  <h1>Connected</h1>
  <p id="who"></p>
  <p id="back">Taking you back…</p>
  <p><a id="manual" href="#">Continue</a></p>
</section>
<section id="failed" class="state" hidden>
  <h1>Couldn't sign in</h1>
  <p class="error" id="error" role="alert"></p>
  <a class="button" href="${escapeHtml(retry)}">Try again</a>
  <div class="widget"><script async src="https://telegram.org/js/telegram-widget.js?22"
    data-telegram-login="${bot}" data-size="medium" data-radius="8"
    data-auth-url="${escapeHtml(returnUrl)}" data-request-access="write"></script></div>
</section>
<footer><a href="https://t.me/${bot}">@${bot}</a></footer>`,
    200,
    script,
  );
}

/** A verified login becomes a code for the client. Returns the redirect, or why not. */
async function completeLogin(
  deps: OAuthDeps,
  state: StateBlob,
  fields: Record<string, unknown>,
): Promise<string | { error: string }> {
  const user: LoginUser | null = await verifyLogin(fields, deps.config.loginKey);
  if (!user)
    return { error: "Telegram's sign-in could not be verified, or it is too old. Try again." };
  if (!isAllowed(deps.config, user.id)) {
    return {
      error: `This connector is private. Your Telegram ID is ${user.id} — ask its owner to add it to ALLOWED_USER_IDS.`,
    };
  }

  await deps.store.upsertUser({
    user_id: user.id,
    username: user.username ?? null,
    first_name: user.first_name ?? null,
  });

  const code = await sign<CodeBlob>(
    deps.config.signingKey,
    "code",
    { ...state, u: user.id },
    CODE_TTL,
  );
  const target = new URL(state.r);
  target.searchParams.set("code", code);
  if (state.s) target.searchParams.set("state", state.s);
  return target.toString();
}

/**
 * Tokens for `userId`. The session is resolved last, after every other
 * database call, so a refresh that moves the session on cannot then fail
 * and leave the client holding a token already retired.
 */
async function issueTokens(
  deps: OAuthDeps,
  userId: number,
  resolveSession: () => Promise<RefreshSession | null>,
) {
  await deps.store.markConnected(userId);
  const user = await deps.store.getUser(userId);
  const version = user?.token_version ?? 0;
  const payload = { u: userId, v: version };
  const session = await resolveSession();
  if (!session) return null;
  return {
    access_token: await sign<TokenBlob>(
      deps.config.signingKey,
      "access",
      { ...payload, s: session.id },
      ACCESS_TTL,
    ),
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    scope: SCOPE,
    refresh_token: await sign<RefreshBlob>(
      deps.config.signingKey,
      "refresh",
      { ...payload, s: session.id, g: session.generation },
      REFRESH_TTL,
    ),
  };
}

/**
 * Retire the presented refresh token: the session and generation to issue
 * next, or null when the token was already used and the session is now
 * revoked.
 */
async function rotate(
  deps: OAuthDeps,
  token: string,
  blob: RefreshBlob,
): Promise<RefreshSession | null> {
  const id = blob.s ?? (await sha256Base64Url(token));
  const presented = blob.g ?? 0;
  const expiresAt = nowSeconds() + REFRESH_TTL;
  if (await deps.store.advanceRefresh(id, blob.u, presented, expiresAt)) {
    return { id, generation: presented + 1 };
  }
  const current = await deps.store.getRefreshSession(id);
  if (
    current &&
    !current.revoked &&
    current.user_id === blob.u &&
    current.generation === presented + 1 &&
    nowSeconds() - current.rotated_at <= ROTATION_GRACE
  ) {
    return { id, generation: current.generation };
  }
  await deps.store.revokeRefreshSession(id, blob.u, expiresAt);
  console.warn(JSON.stringify({ event: "refresh_reuse", user: blob.u, session: id.slice(0, 8) }));
  return null;
}

/**
 * Whether a token minted for `blob` still stands — user still allowed,
 * version not bumped, its sign-in not ended — and if so, how the user is
 * named in Telegram. One read. An access token's sign-in must exist (it is
 * recorded before the token is issued); a refresh token's may not yet, for
 * sign-ins from before they were recorded.
 */
async function stillValid(
  deps: OAuthDeps,
  blob: TokenBlob,
  kind: "access" | "refresh",
): Promise<{ username: string | null; name: string | null; client: string | null } | null> {
  if (!isAllowed(deps.config, blob.u)) return null;
  const state = await deps.store.tokenState(blob.u, blob.s ?? null);
  // Sessions from before connected_at existed get it on their first call.
  if (state && state.connected_at === null) await deps.store.markConnected(blob.u);
  if ((state?.token_version ?? 0) !== blob.v) return null;
  if (blob.s && state?.session_revoked === 1) return null;
  if (blob.s && kind === "access" && state?.session_revoked !== 0) return null;
  return {
    username: state?.username ?? null,
    name: state?.first_name ?? null,
    client: state?.client_name ?? null,
  };
}

async function handleToken(request: Request, deps: OAuthDeps): Promise<Response> {
  if (request.method !== "POST") {
    return oauthError("invalid_request", "The token endpoint only accepts POST.", 405);
  }
  if (!(await allow(deps.env.AUTH_LIMIT, clientIp(request)))) {
    return oauthError(
      "temporarily_unavailable",
      "Too many requests. Wait a minute.",
      429,
      RETRY_AFTER_HEADERS,
    );
  }

  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type");

  if (grantType === "refresh_token") {
    const presented = form.get("refresh_token") ?? "";
    const blob = await verify<RefreshBlob>(deps.config.signingKey, "refresh", presented);
    const tokens =
      blob &&
      (await stillValid(deps, blob, "refresh")) &&
      (await issueTokens(deps, blob.u, () => rotate(deps, presented, blob)));
    if (!tokens) {
      return oauthError("invalid_grant", "The refresh token is not valid any more. Connect again.");
    }
    return jsonResponse(tokens);
  }

  if (grantType !== "authorization_code") {
    return oauthError(
      "unsupported_grant_type",
      "Supported grants are authorization_code and refresh_token.",
    );
  }

  const code = await verify<CodeBlob>(deps.config.signingKey, "code", form.get("code") ?? "");
  if (!code) return oauthError("invalid_grant", "The authorization code is not valid or expired.");

  const redirectUri = form.get("redirect_uri");
  if (redirectUri && redirectUri !== code.r) {
    return oauthError("invalid_grant", "redirect_uri does not match the /authorize call.");
  }
  const clientId = readClientId(form, request);
  if (clientId && (await sha256Base64Url(clientId)) !== code.cid) {
    return oauthError("invalid_grant", "The code was issued to a different client.");
  }

  const verifier = form.get("code_verifier");
  if (!verifier) return oauthError("invalid_request", "Missing code_verifier (PKCE).");
  if ((await sha256Base64Url(verifier)) !== code.c) {
    return oauthError("invalid_grant", "code_verifier does not match code_challenge.");
  }
  if (!isAllowed(deps.config, code.u)) {
    return oauthError("access_denied", "This Telegram account may not use this connector.", 403);
  }

  const fresh = { id: randomId(), generation: 0 };
  const tokens = await issueTokens(deps, code.u, async () => {
    await deps.store.createSignIn(fresh.id, code.u, code.cn ?? null, nowSeconds() + REFRESH_TTL);
    return fresh;
  });
  return jsonResponse(tokens);
}

// --- public surface --------------------------------------------------------

const RATE_LIMITED = new Set(["/register", "/auth/telegram"]);

/** Discovery, /register, /authorize, /auth/telegram and /token; undefined for anything else. */
export async function handleOAuthRequest(
  request: Request,
  deps: () => Promise<OAuthDeps>,
): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);

  const config = await deps();
  const discovery = oauthMetadataResponse(request, metadataOptions(publicMcpUrl(request)));
  if (discovery) return discovery;

  if (request.method === "OPTIONS" && ["/authorize", "/token", "/register"].includes(pathname)) {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (RATE_LIMITED.has(pathname) && !(await allow(config.env.AUTH_LIMIT, clientIp(request)))) {
    return oauthError(
      "temporarily_unavailable",
      "Too many requests. Wait a minute.",
      429,
      RETRY_AFTER_HEADERS,
    );
  }

  switch (pathname) {
    case "/register":
      return handleRegister(request, config);
    case "/authorize":
      return handleAuthorize(request, config);
    case "/auth/telegram":
      return handleTelegramReturn(request, config);
    case "/token":
      return handleToken(request, config);
    default:
      return undefined;
  }
}

/** Paths this module answers, so the router can avoid building deps for anything else. */
export function isOAuthPath(pathname: string): boolean {
  return (
    pathname.startsWith("/.well-known/oauth-") ||
    ["/register", "/authorize", "/auth/telegram", "/token"].includes(pathname)
  );
}

export interface McpAuth {
  userId: number;
  username: string | null;
  name: string | null;
  /** Who the sign-in went to ("Claude", "ChatGPT"…), when known. */
  client: string | null;
}

/** Bearer gate for the MCP endpoint: the verified user, or a ready 401. */
export function authorizeMcpRequest(
  request: Request,
  deps: OAuthDeps,
): Promise<AuthInfo | Response> {
  const gate = requireBearerAuth({
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(publicMcpUrl(request)),
    verifier: {
      async verifyAccessToken(token: string): Promise<AuthInfo> {
        const blob = await verify<TokenBlob>(deps.config.signingKey, "access", token);
        const profile = blob && (await stillValid(deps, blob, "access"));
        if (!blob || !profile) {
          throw new OAuthError(
            OAuthErrorCode.InvalidToken,
            "Access token is not valid or expired.",
          );
        }
        return {
          token,
          clientId: "telegram",
          scopes: [SCOPE],
          expiresAt: blob.exp,
          extra: { userId: blob.u, ...profile } satisfies McpAuth as unknown as Record<
            string,
            unknown
          >,
        };
      },
    },
  });
  return gate(request);
}

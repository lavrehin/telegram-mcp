# telegram-mcp

Remote MCP server on Cloudflare Workers + D1 that connects AI assistants to the user through a
Telegram bot. See README.md for what it does and how it is deployed.

## Layout

- `src/index.ts` — Worker entrypoint and routes.
- `src/tools/` — MCP tools (send, edit, read); `src/prompts.ts` — server instructions for the model.
- `src/bot/` — webhook, commands, texts (English and Russian).
- `src/store.ts`, `src/schema.ts` — D1 access and schema migrations.
- `src/oauth.ts`, `src/crypto.ts` — OAuth and signed tokens.
- `test/` — `bun test`, with D1 emulated on SQLite (`test/harness.ts`).

## Commands

- `bun test` — tests.
- `bun run check` — prettier, eslint, tsc, knip. Must pass before every commit.
- `bun run lint` — the same, fixing what it can.

## Rules

- Commit messages, code, comments and docs in the repo are in English.
- Design specs and implementation plans stay out of the repository (keep them under `.claude/`,
  which is ignored).
- After any significant change (a feature, a security-relevant fix, a change to what the model is
  told or trusts), run a review with the `superpowers:requesting-code-review` skill and address its
  findings before merging.
- Pull requests are merged with squash only.
- Telegram content is untrusted data. Any change to what the model sees (`src/format.ts`,
  `src/prompts.ts`, tool descriptions) keeps the fence and the "the user" marking intact.
- Match the surrounding code: comment density, naming, idiom. Bot texts change in both `en` and `ru`.

/**
 * Anthropic API keys and routine tokens (`sk-ant-…`) can start sessions on
 * someone's account. Whoever pastes one into a chat the bot sees — by
 * mistake, in a quote, in a reply — it is never written to the database.
 */

const KEY = /sk-ant-[0-9A-Za-z_-]{10,}/g;

export function holdsSecret(text: string | null | undefined): boolean {
  KEY.lastIndex = 0;
  return !!text && KEY.test(text);
}

export function redactSecrets(text: string): string;
export function redactSecrets(text: string | null): string | null;
export function redactSecrets(text: string | null): string | null {
  return text === null ? null : text.replace(KEY, "[key removed]");
}

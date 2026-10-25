/**
 * Markdown → Telegram HTML.
 *
 * Models write Markdown; Telegram's own MarkdownV2 makes them escape a dozen
 * characters and rejects the whole message on one miss. Telegram HTML only
 * needs `<`, `>` and `&` escaped, so the conversion here is: escape everything,
 * then turn the Markdown a model actually writes into the handful of tags
 * Telegram allows. Emphasis is matched with a stack: a delimiter closes only
 * the innermost open one, and anything left open turns back into literal
 * text, so the output is always properly nested — the one property Telegram
 * insists on (it rejects the whole message otherwise).
 *
 * Telegram's 4096-character limit counts the text after parsing, without
 * tags, so splitting works on the Markdown source.
 */

import { escapeHtml } from "./bot/texts";

export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;
/** Room for the markup characters a chunk loses in conversion is not needed; this is margin. */
const CHUNK_LIMIT = 4000;

const PLACEHOLDER = "\u0000";

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:\/\/|tg:\/\/|mailto:)/i.test(trimmed) ? trimmed : null;
}

const EMPHASIS: [delimiter: string, tag: string][] = [
  ["**", "b"],
  ["__", "b"],
  ["~~", "s"],
  ["||", "tg-spoiler"],
  ["*", "i"],
  ["_", "i"],
];

const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

/**
 * Bold, italic, strike and spoiler over already-escaped text. Single `*` and
 * `_` only count at word edges, so snake_case and 2*3*4 stay as written.
 */
function emphasis(text: string): string {
  const out: string[] = [];
  const open: { delimiter: string; tag: string; at: number }[] = [];

  for (let i = 0; i < text.length;) {
    const match = EMPHASIS.find(([delimiter]) => text.startsWith(delimiter, i));
    if (!match) {
      out.push(text[i]);
      i++;
      continue;
    }
    const [delimiter, tag] = match;
    const before = text[i - 1] ?? " ";
    const after = text[i + delimiter.length] ?? " ";
    const single = delimiter.length === 1;
    const top = open.at(-1);

    const closes =
      top?.delimiter === delimiter && !SPACE.test(before) && !(single && WORD.test(after));
    const opens =
      !closes &&
      !SPACE.test(after) &&
      !(single && WORD.test(before)) &&
      !open.some((entry) => entry.delimiter === delimiter);

    if (closes) {
      out[top.at] = `<${tag}>`;
      out.push(`</${tag}>`);
      open.pop();
    } else if (opens) {
      open.push({ delimiter, tag, at: out.length });
      out.push(delimiter); // stays literal unless closed later
    } else {
      out.push(delimiter);
    }
    i += delimiter.length;
  }
  return out.join("");
}

/** Inline Markdown on one line of text that contains no code fences. */
function inline(text: string): string {
  const stash: string[] = [];
  const keep = (html: string) => `${PLACEHOLDER}${stash.push(html) - 1}${PLACEHOLDER}`;

  // Code spans first: nothing inside them is Markdown.
  let out = text.replace(/`([^`\n]+)`/g, (_, code: string) =>
    keep(`<code>${escapeHtml(code)}</code>`),
  );

  // Links before escaping, so the URL is taken as written.
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label: string, url: string) => {
    const href = safeUrl(url);
    return href ? keep(`<a href="${escapeAttribute(href)}">${inline(label)}</a>`) : whole;
  });

  out = emphasis(escapeHtml(out));

  return out.replace(
    new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g"),
    (_, index: string) => stash[Number(index)],
  );
}

function block(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let quote: string[] = [];

  const flushQuote = () => {
    if (!quote.length) return;
    out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = [];
  };

  for (const line of lines) {
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      quote.push(inline(quoted[1]));
      continue;
    }
    flushQuote();

    const heading = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(`<b>${inline(heading[1])}</b>`);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}• ${inline(bullet[2])}`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("──────────");
      continue;
    }
    out.push(inline(line));
  }
  flushQuote();
  return out.join("\n");
}

export function markdownToHtml(markdown: string): string {
  const parts: string[] = [];
  const fence = /```([\w+-]*)[^\n]*\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  for (const match of markdown.matchAll(fence)) {
    parts.push(block(markdown.slice(last, match.index)));
    const language = match[1];
    const code = escapeHtml(match[2].replace(/\n$/, ""));
    parts.push(
      language
        ? `<pre><code class="language-${escapeAttribute(language)}">${code}</code></pre>`
        : `<pre>${code}</pre>`,
    );
    last = match.index + match[0].length;
  }
  parts.push(block(markdown.slice(last)));
  return parts.join("");
}

/**
 * Split long Markdown into messages Telegram accepts: on blank lines first,
 * then on lines, then hard. A split inside a code fence closes it and opens it
 * again in the next part, so each part renders on its own.
 */
export function splitMarkdown(markdown: string, limit = CHUNK_LIMIT): string[] {
  if (markdown.length <= limit) return [markdown];

  const chunks: string[] = [];
  let current = "";
  let fence: string | null = null;

  const push = () => {
    if (!current) return;
    chunks.push(fence !== null ? `${current}\n\`\`\`` : current);
    current = fence !== null ? `\`\`\`${fence}\n` : "";
  };

  for (const rawLine of markdown.split("\n")) {
    let line = rawLine;
    // Lines longer than a whole chunk are cut hard.
    while (line.length > limit - 10) {
      if (current) push();
      current += line.slice(0, limit - 10);
      line = line.slice(limit - 10);
      push();
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      push();
      current = current ? `${current}${line}` : line;
    } else {
      current = candidate;
    }

    const toggle = /^\s*```([\w+-]*)/.exec(line);
    if (toggle) fence = fence === null ? toggle[1] : null;
  }
  if (current) chunks.push(current);
  return chunks.filter((chunk) => chunk.trim());
}

export function splitPlain(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit));
  return chunks.length ? chunks : [""];
}

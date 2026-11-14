/**
 * The small Markdown subset the legal documents are written in, parsed into blocks the reading
 * screen draws and `scripts/sync-legal.js` turns into the hostable HTML pages. One parser for both,
 * so the app and the web copy can't read the same text differently.
 *
 * Blocks: `#`, `##` and `###` headings, paragraphs (consecutive lines joined), `- ` list items (two
 * spaces before the dash for a nested item) and `---` rules. Inline: `**bold**` and `[text](url)`.
 * Nothing else is special.
 *
 * Dependency-free on purpose: Node reads this file directly (`--experimental-strip-types`) when the
 * sync script runs, where neither `@/` nor any package resolves.
 */

export type Span = { kind: 'text'; text: string; bold: boolean } | { kind: 'link'; text: string; url: string; bold: boolean };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'item'; depth: 0 | 1; spans: Span[] }
  | { kind: 'rule' };

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/** The inline spans of one run of text: links found first, then `**` toggles bold across the run. */
export function parseInline(source: string): Span[] {
  const spans: Span[] = [];
  let bold = false;
  const pushText = (raw: string) => {
    const parts = raw.split('**');
    parts.forEach((part, i) => {
      if (i > 0) bold = !bold;
      if (part !== '') spans.push({ kind: 'text', text: part, bold });
    });
  };
  let at = 0;
  for (const m of source.matchAll(LINK)) {
    pushText(source.slice(at, m.index));
    spans.push({ kind: 'link', text: m[1]!.replaceAll('**', ''), url: m[2]!, bold });
    at = m.index + m[0].length;
  }
  pushText(source.slice(at));
  return spans;
}

/** Every block of a document, in order. */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let item: { depth: 0 | 1; lines: string[] } | null = null;

  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join(' ')) });
    if (item !== null) blocks.push({ kind: 'item', depth: item.depth, spans: parseInline(item.lines.join(' ')) });
    paragraph = [];
    item = null;
  };

  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flush();
      continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1]!.length as 1 | 2 | 3, text: heading[2]!.trim() });
      continue;
    }
    if (line.trim() === '---') {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }
    const bullet = /^( *)- (.+)$/.exec(line);
    if (bullet) {
      flush();
      item = { depth: bullet[1]!.length >= 2 ? 1 : 0, lines: [bullet[2]!.trim()] };
      continue;
    }
    // A continuation line belongs to the list item or paragraph it follows.
    if (item !== null) item.lines.push(line.trim());
    else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** The plain text of some spans (accessibility labels, tests). */
export const spansText = (spans: readonly Span[]): string => spans.map((s) => s.text).join('');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The document's version: its "Last updated" date as `YYYY-MM-DD`, the form the sign-in checkbox
 * records (`TERMS_VERSION`). Null when the line is missing or not a date.
 */
export function lastUpdatedVersion(source: string): string | null {
  const m = /\*\*Last updated:\*\* ([A-Z][a-z]+) (\d{1,2}), (\d{4})/.exec(source);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!);
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}

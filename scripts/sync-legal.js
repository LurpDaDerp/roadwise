#!/usr/bin/env node
'use strict';
/**
 * Copies the Terms of Service and the Privacy Policy from the local drafts in `legal/` (git-ignored,
 * never committed) into the app, and writes the hostable web pages beside the drafts.
 *
 *   npm run legal:sync
 *
 * - `src/features/legal/documents.ts` (committed): both documents' Markdown and version, which the
 *   in-app reading screen (`app/legal/[doc].tsx`) draws. Commit it after every sync.
 * - `legal/terms-of-service.html` and `legal/privacy-policy.html` (git-ignored): standalone pages to
 *   host for App Store Connect's Privacy Policy URL and the custom EULA.
 *
 * Both are built by `src/features/legal/markdown.ts` (Node reads it directly with
 * `--experimental-strip-types`), the same parser the app uses. Each document's version is its
 * "Last updated" date; `TERMS_VERSION` in `src/features/auth/legal.ts` must equal the newer of the
 * two (`src/features/legal/__tests__/documents.test.ts` holds them equal), so bump it with the text.
 */

const fs = require('fs');
const path = require('path');

const { parseMarkdown, lastUpdatedVersion } = require('../src/features/legal/markdown.ts');

const ROOT = path.resolve(__dirname, '..');
const LEGAL = path.join(ROOT, 'legal');
const OUT = path.join(ROOT, 'src', 'features', 'legal', 'documents.ts');

const DOCS = [
  { key: 'terms', file: 'terms-of-service' },
  { key: 'privacy', file: 'privacy-policy' },
];

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeUrl = (u) => /^(https:\/\/|mailto:)/i.test(u);

function spansHtml(spans) {
  return spans
    .map((s) => {
      const text = escape(s.text);
      const inner = s.kind === 'link' && safeUrl(s.url) ? `<a href="${escape(s.url)}">${text}</a>` : text;
      return s.bold ? `<strong>${inner}</strong>` : inner;
    })
    .join('');
}

function bodyHtml(blocks) {
  const out = [];
  let inList = false;
  for (const b of blocks) {
    if (b.kind !== 'item' && inList) {
      out.push('</ul>');
      inList = false;
    }
    if (b.kind === 'heading') out.push(`<h${b.level}>${escape(b.text)}</h${b.level}>`);
    else if (b.kind === 'paragraph') out.push(`<p>${spansHtml(b.spans)}</p>`);
    else if (b.kind === 'rule') out.push('<hr>');
    else {
      if (!inList) out.push('<ul>');
      inList = true;
      // A nested item is drawn indented in the same list, as the app draws it.
      out.push(`<li${b.depth === 1 ? ' class="sub"' : ''}>${spansHtml(b.spans)}</li>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

function page(title, blocks) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 17px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; color: #1b1f24; background: #ffffff; }
  h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 1rem; }
  h2 { font-size: 1.35rem; margin: 2.25rem 0 0.5rem; }
  h3 { font-size: 1.1rem; margin: 1.5rem 0 0.4rem; }
  p, li { margin: 0.5rem 0; }
  ul { padding-left: 1.4rem; }
  li.sub { margin-left: 1.4rem; list-style-type: circle; }
  a { color: #0a5bd3; }
  hr { border: 0; border-top: 1px solid #d0d7de; margin: 2rem 0; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6edf3; background: #0d1117; }
    a { color: #6cb6ff; }
    hr { border-top-color: #30363d; }
  }
</style>
</head>
<body>
${bodyHtml(blocks)}
</body>
</html>
`;
}

const entries = [];
for (const { key, file } of DOCS) {
  const src = path.join(LEGAL, `${file}.md`);
  if (!fs.existsSync(src)) {
    console.error(`missing ${path.relative(ROOT, src)}: the legal drafts live in legal/ (git-ignored) on the machine that writes them`);
    process.exit(1);
  }
  const source = fs.readFileSync(src, 'utf8').replace(/\r\n?/g, '\n');
  const blocks = parseMarkdown(source);
  const first = blocks[0];
  if (!first || first.kind !== 'heading' || first.level !== 1) throw new Error(`${file}.md must start with a # title`);
  const version = lastUpdatedVersion(source);
  if (version === null) throw new Error(`${file}.md needs a "**Last updated:** Month D, YYYY" line`);
  fs.writeFileSync(path.join(LEGAL, `${file}.html`), page(first.text, blocks), 'utf8');
  entries.push({ key, title: first.text, version, source });
}

const body = entries
  .map(
    (e) =>
      `  ${e.key}: {\n    title: ${JSON.stringify(e.title)},\n    version: ${JSON.stringify(e.version)},\n    source: ${JSON.stringify(e.source)},\n  },`
  )
  .join('\n');

fs.writeFileSync(
  OUT,
  `// Written by \`npm run legal:sync\` from legal/*.md (local drafts, git-ignored). Do not edit by hand.\n\n` +
    `export const LEGAL_DOCUMENTS = {\n${body}\n} as const;\n\n` +
    `export type LegalDocKey = keyof typeof LEGAL_DOCUMENTS;\n`,
  'utf8'
);

console.log(`wrote ${path.relative(ROOT, OUT)} and ${DOCS.map((d) => `legal/${d.file}.html`).join(', ')}`);

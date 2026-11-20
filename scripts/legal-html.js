'use strict';
/**
 * The legal documents' Markdown blocks (`src/features/legal/markdown.ts`) as HTML: shared by
 * `sync-legal.js` (the standalone pages beside the drafts) and `build-site.js` (getroadwise.app).
 */

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
    if (b.kind === 'heading') {
      // Sections get stable anchors (getroadwise.app/privacy#4-your-choices) for store forms.
      const id = b.level > 1 ? ` id="${b.text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}"` : '';
      out.push(`<h${b.level}${id}>${escape(b.text)}</h${b.level}>`);
    }
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

module.exports = { escape, bodyHtml };

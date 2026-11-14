/**
 * The bundled documents: well formed, versioned, carrying the operator's contact details, and the
 * version the sign-in checkbox records is the newest of them. Where the local drafts exist (the
 * machine that writes them; `legal/` is git-ignored), the bundle must be a fresh `npm run legal:sync`.
 */
import { TERMS_VERSION } from '@/features/auth/legal';
import { LEGAL_DOCUMENTS } from '@/features/legal/documents';
import { lastUpdatedVersion, parseMarkdown } from '@/features/legal/markdown';

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a Node read in a test
const fs = require('node:fs') as { existsSync(f: string): boolean; readFileSync(f: string, e: 'utf8'): string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { resolve: (...p: string[]) => string };

const DRAFTS = { terms: 'terms-of-service.md', privacy: 'privacy-policy.md' } as const;

test.each(Object.entries(LEGAL_DOCUMENTS))('%s: titled, versioned by its Last updated line, with the contact email', (_key, doc) => {
  const blocks = parseMarkdown(doc.source);
  expect(blocks[0]).toEqual({ kind: 'heading', level: 1, text: doc.title });
  expect(lastUpdatedVersion(doc.source)).toBe(doc.version);
  expect(doc.source).toContain('[roadwise.contact@gmail.com](mailto:roadwise.contact@gmail.com)');
  expect(doc.source).toContain('Julian Huang');
});

test('the sign-in checkbox records the newest document version', () => {
  const newest = Object.values(LEGAL_DOCUMENTS)
    .map((d) => d.version as string)
    .sort()
    .at(-1);
  expect(TERMS_VERSION).toBe(newest);
});

test('the bundle matches the local drafts, where they exist', () => {
  for (const [key, file] of Object.entries(DRAFTS) as [keyof typeof DRAFTS, string][]) {
    const draft = path.resolve(__dirname, '../../../../legal', file);
    if (!fs.existsSync(draft)) continue;
    expect(LEGAL_DOCUMENTS[key].source).toBe(fs.readFileSync(draft, 'utf8').replace(/\r\n?/g, '\n'));
  }
});

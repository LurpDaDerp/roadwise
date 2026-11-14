import { lastUpdatedVersion, parseInline, parseMarkdown, spansText } from '@/features/legal/markdown';

test('headings, paragraphs joined across lines, list items, nested items and rules', () => {
  const blocks = parseMarkdown('# Title\n\nOne line\nand the next.\n\n## Section\n\n- First\n  carried on\n  - Nested\n- Second\n\n---\n\n### Sub');
  expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'heading', 'item', 'item', 'item', 'rule', 'heading']);
  expect(blocks[0]).toEqual({ kind: 'heading', level: 1, text: 'Title' });
  expect(blocks[1]!.kind === 'paragraph' && spansText(blocks[1]!.spans)).toBe('One line and the next.');
  expect(blocks[3]!.kind === 'item' && [blocks[3]!.depth, spansText(blocks[3]!.spans)]).toEqual([0, 'First carried on']);
  expect(blocks[4]!.kind === 'item' && blocks[4]!.depth).toBe(1);
  expect(blocks[7]).toEqual({ kind: 'heading', level: 3, text: 'Sub' });
});

test('bold and links inline, and Windows line ends', () => {
  expect(parseInline('**Bold:** then [mail](mailto:a@b.c) and **[web](https://x.test)**.')).toEqual([
    { kind: 'text', text: 'Bold:', bold: true },
    { kind: 'text', text: ' then ', bold: false },
    { kind: 'link', text: 'mail', url: 'mailto:a@b.c', bold: false },
    { kind: 'text', text: ' and ', bold: false },
    { kind: 'link', text: 'web', url: 'https://x.test', bold: true },
    { kind: 'text', text: '.', bold: false },
  ]);
  expect(parseMarkdown('# A\r\n\r\nB').map((b) => b.kind)).toEqual(['heading', 'paragraph']);
});

test('the version is the "Last updated" date', () => {
  expect(lastUpdatedVersion('**Last updated:** November 3, 2026')).toBe('2026-11-03');
  expect(lastUpdatedVersion('**Last updated:** Someday 3, 2026')).toBeNull();
  expect(lastUpdatedVersion('no date')).toBeNull();
});

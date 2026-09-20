import { CONSTANTS } from '@scoring';
import type { EventCategory } from '@scoring';

import {
  capTotal,
  categoryCaps,
  scoringChangelog,
  scoringExplainer,
  type ExplainerBlockId,
} from '../scoring-explainer';

const CATEGORIES = Object.keys(CONSTANTS.CATEGORY) as EventCategory[];

/** The E4 item list, copied from the product spec §7.E. */
const E4_ITEMS: readonly ExplainerBlockId[] = [
  'measured',
  'notMeasured',
  'caps',
  'confidence',
  'context',
  'disputes',
  'notAScore',
  'initialModel',
];

const blockFor = (id: ExplainerBlockId) => scoringExplainer.find((b) => b.id === id);

describe('scoring explainer blocks', () => {
  test('has a block for every E4 item, in reading order', () => {
    expect(scoringExplainer.map((b) => b.id)).toEqual([...E4_ITEMS]);
  });

  test('gives every block a non-empty title and body', () => {
    const empty = scoringExplainer
      .filter((b) => b.title.trim().length === 0 || b.body.trim().length === 0)
      .map((b) => b.id);
    expect(empty).toEqual([]);
  });

  test('gives every bullet list at least two non-empty bullets', () => {
    const bad = scoringExplainer
      .filter((b) => b.bullets !== undefined)
      .filter(
        (b) =>
          (b.bullets ?? []).length < 2 || (b.bullets ?? []).some((line) => line.trim().length === 0)
      )
      .map((b) => b.id);
    expect(bad).toEqual([]);
  });

  test('writes each body as a readable paragraph, not a single line', () => {
    const short = scoringExplainer.filter((b) => b.body.split(/\s+/).length < 20).map((b) => b.id);
    expect(short).toEqual([]);
  });

  // §9.10: the explainer builds trust, so it never reaches for punishment or guilt. It may name
  // legal fault and insurance rating, because saying what the score is *not* is the point of E4.
  test('uses no punishing, scare or guilt language', () => {
    const banned = [
      /\bfail(s|ed|ing|ure)?\b/i,
      /\bpunish/i,
      /\bguilt/i,
      /\bshame|\bashamed\b/i,
      /\breckless|\bcareless|\bstupid/i,
      /\bdisappoint/i,
      /\byour (family|parents) (is|are) worried\b/i,
    ];
    const copy = scoringExplainer
      .map((b) => [b.title, b.body, ...(b.bullets ?? [])].join(' '))
      .join(' ');
    expect(banned.filter((p) => p.test(copy)).map(String)).toEqual([]);
  });

  test('says plainly what the score is not', () => {
    const block = blockFor('notAScore');
    const copy = [block?.body, ...(block?.bullets ?? [])].join(' ').toLowerCase();
    expect(copy).toContain('legal fault');
    expect(copy).toContain('insurance rating');
  });

  test('says the model is an initial one that is still being tuned', () => {
    const block = blockFor('initialModel');
    expect(block?.title.toLowerCase()).toContain('initial');
    expect(block?.body.toLowerCase()).toContain('tuning');
    expect(block?.body.toLowerCase()).toContain('version');
  });

  test('tells the driver how to dispute an event', () => {
    expect(blockFor('disputes')?.body.toLowerCase()).toContain("this isn't right");
  });
});

describe('per-category caps', () => {
  test('lists every scoring category exactly once', () => {
    expect([...categoryCaps.map((c) => c.category)].sort()).toEqual([...CATEGORIES].sort());
  });

  test('matches the scoring constants', () => {
    const mismatched = categoryCaps.filter(
      (entry) => entry.cap !== CONSTANTS.CATEGORY[entry.category].cap
    );
    expect(mismatched).toEqual([]);
  });

  test('adds up to 100, the whole of a trip score', () => {
    expect(capTotal).toBe(100);
    expect(CATEGORIES.reduce((sum, c) => sum + CONSTANTS.CATEGORY[c].cap, 0)).toBe(capTotal);
  });

  test('reads largest cap first', () => {
    const caps = categoryCaps.map((c) => c.cap);
    expect(caps).toEqual([...caps].sort((a, b) => b - a));
  });

  test('gives every category a non-empty label and description', () => {
    const empty = categoryCaps
      .filter((c) => c.label.trim().length === 0 || c.measures.trim().length === 0)
      .map((c) => c.category);
    expect(empty).toEqual([]);
  });

  test('is quoted in the caps block, so the screen cannot drift from the engine', () => {
    const bullets = blockFor('caps')?.bullets ?? [];
    expect(bullets).toHaveLength(categoryCaps.length);
    for (const entry of categoryCaps) {
      expect(bullets.some((line) => line.includes(entry.label) && line.includes(String(entry.cap))))
        .toBe(true);
    }
  });
});

describe('scoring changelog', () => {
  test('starts at version 1, the initial model', () => {
    expect(scoringChangelog).toEqual([{ version: 1, date: '2026-09-20', summary: 'Initial model' }]);
  });

  test('dates every entry as an ISO day', () => {
    for (const entry of scoringChangelog) expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('reads newest first, with unique ascending version numbers', () => {
    const versions = scoringChangelog.map((e) => e.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual([...versions].sort((a, b) => b - a));
  });

  test('covers the version the scorer currently stamps on a trip', () => {
    expect(scoringChangelog.some((e) => e.version === 1)).toBe(true);
  });
});

import { render, screen } from '@testing-library/react-native';

import { ThemeProvider } from '@/ui';
import { plainBundle } from '@/ui/sky/palette';

import { textsUnder } from '../__fixtures__/texts';
import { MeritFacts, type MeritFactsProps } from '../MeritFacts';
import { meritInk } from '../merit';

// Dynamic Type at the phone's default (jest's own window says 2×).
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 750, height: 1334, scale: 2, fontScale: 1 }),
}));

const scene = plainBundle('light').sky.scene;
const paper = plainBundle('light').colors;

const fixture: Omit<MeritFactsProps, 'size' | 'surfaces' | 'plainInk' | 'testID'> = { score: 92, miles: 12, durationS: 1440, units: 'mi', tier: 4 };

const draw = (p: MeritFactsProps) =>
  render(
    <ThemeProvider scheme="light" reduceMotion>
      <MeritFacts {...p} />
    </ThemeProvider>
  );

/** The facts as drawn: each string in order with its colour. */
function drawn(testID: string): { text: string; color: unknown }[] {
  return textsUnder(testID).map((x) => ({ text: x.text, color: x.style.color }));
}

test('the card and the hero draw the same three labelled values in the same order, with the same ink per value', async () => {
  await draw({ ...fixture, size: 'card', surfaces: scene, plainInk: '#FFFFFF', testID: 'card' });
  const card = drawn('card');
  await draw({ ...fixture, size: 'hero', surfaces: [paper.surface], plainInk: paper.text, testID: 'hero' });
  const hero = drawn('hero');
  expect(card.map((x) => x.text)).toEqual(['92', 'score', '12.0 mi', 'distance', '24 min', 'time']);
  expect(hero.map((x) => x.text)).toEqual(card.map((x) => x.text));
  // Within each: score, distance and time share the tier ink; the labels share the plain ink.
  for (const facts of [card, hero]) {
    expect(facts[0]!.color).toBe(facts[2]!.color);
    expect(facts[2]!.color).toBe(facts[4]!.color);
    expect(facts[1]!.color).toBe(facts[3]!.color);
    expect(facts[3]!.color).toBe(facts[5]!.color);
    expect(facts[0]!.color).not.toBe(facts[1]!.color);
  }
  // The ink is the tier's, repaired for the ground each sits on.
  expect(card[0]!.color).toBe(meritInk(4, scene));
  expect(hero[0]!.color).toBe(meritInk(4, [paper.surface]));
  expect(screen.getByTestId('hero')).toHaveProp('accessibilityLabel', 'Score 92 out of 100, 12.0 miles, 24 minutes, merit 4 of 5.');
});

test('both carry the tier icon beside the score: 28 pt on the card, 22 on the hero', async () => {
  await draw({ ...fixture, size: 'card', surfaces: scene, plainInk: '#FFFFFF', testID: 'card' });
  expect(screen.getByTestId('card-icon', { includeHiddenElements: true })).toHaveProp('width', 28);
  await draw({ ...fixture, size: 'hero', surfaces: [paper.surface], plainInk: paper.text, testID: 'hero' });
  expect(screen.getByTestId('hero-icon', { includeHiddenElements: true })).toHaveProp('width', 22);
});

test('no tier (no score): a dash, no icon, and the plain ink everywhere', async () => {
  await draw({ ...fixture, score: null, tier: null, size: 'hero', surfaces: [paper.surface], plainInk: paper.text, testID: 'hero' });
  expect(screen.queryByTestId('hero-icon', { includeHiddenElements: true })).toBeNull();
  const facts = drawn('hero');
  expect(facts[0]!.text).toBe('—');
  expect(facts[0]!.color).toBe(paper.text);
  expect(facts[2]!.color).toBe(paper.text);
  expect(screen.getByTestId('hero')).toHaveProp('accessibilityLabel', 'No score, 12.0 miles, 24 minutes.');
});

test('the labels are lowercase words, never a tier name', async () => {
  await draw({ ...fixture, size: 'card', surfaces: scene, plainInk: '#FFFFFF', testID: 'card' });
  const words = drawn('card').map((x) => x.text);
  expect(words.filter((w) => /^[a-z]+$/.test(w))).toEqual(['score', 'distance', 'time']);
  expect(words.join(' ')).not.toMatch(/Rolling|Steady|Smooth drive|Polished|Grand tour|merit/i);
});

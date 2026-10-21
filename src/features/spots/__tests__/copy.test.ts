/** @jest-environment node */
import { DIRECTIONS, spotsCopy } from '../copy';
import { chipText, dirWord, howOften, limitText, progress, spotTitle, whatHappens } from '../format';
import { problemSpot } from '../__fixtures__/spots';

/** Promises the app never makes (onboarding's list): score guarantees, streak pressure, money, shouting. */
const BANNED_COPY: readonly RegExp[] = [
  /never lowers|can(no|')t go down|never decays/i,
  /lose your streak|about to lose|hurry|last chance/i,
  /\$|\bcash\b|money|dollars?|gift ?cards?|redeem|prizes?|insurance|discounts?/i,
  /!/,
];

/** Every string, with the functions called on sample values. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'function') {
    const samples = [[1], [3], [2, 6], [6, 6], ['Dexter Ave N', 'Speeding', 'south', '4 of your last 6 drives here', true], ['35 mph'], ['Watch your speed here'], ['Speeding', 'south']];
    return samples.flatMap((args) => {
      try {
        const out: unknown = (value as (...a: unknown[]) => unknown)(...args);
        return typeof out === 'string' ? [out] : [];
      } catch {
        return [];
      }
    });
  }
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

const words = (s: string) => s.trim().split(/\s+/).length;

describe('spots copy', () => {
  const all = strings(spotsCopy);

  it.each(all.map((s) => [s]))('%p has no em dash, no exclamation and no banned promise', (s) => {
    expect(s).not.toMatch(/—/);
    for (const banned of BANNED_COPY) expect(s).not.toMatch(banned);
  });

  it('says "cleared", never "fixed"', () => {
    for (const s of all) expect(s).not.toMatch(/\bfix(ed)?\b/i);
  });

  it('keeps the captions and map chips to three words at most', () => {
    expect(words(spotsCopy.card.caption)).toBeLessThanOrEqual(3);
    expect(words(spotsCopy.card.gettingBetter)).toBeLessThanOrEqual(3);
    for (const chip of Object.values(spotsCopy.mapChip)) expect(words(chip)).toBeLessThanOrEqual(3);
  });

  it("keeps the driving screen's nudge lines to four words and 22 characters", () => {
    expect(spotsCopy.nudge).toEqual({
      speeding: 'Watch your speed here',
      hard_brake: 'Brake early here',
      hard_corner: 'Take this turn slower',
      hard_accel: 'Start gently here',
    });
    for (const line of Object.values(spotsCopy.nudge)) {
      expect(words(line)).toBeLessThanOrEqual(4);
      expect(line.length).toBeLessThanOrEqual(22);
    }
  });

  it('the card and its footnote, singular and plural', () => {
    expect(spotsCopy.card.title).toBe('Spots to watch');
    expect(spotsCopy.card.caption).toBe('Last 4 months');
    expect(spotsCopy.card.cleared(1)).toBe('1 spot cleared in the last 30 days. Nice driving.');
    expect(spotsCopy.card.cleared(3)).toBe('3 spots cleared in the last 30 days. Nice driving.');
  });
});

describe('spots words from numbers', () => {
  it('a heading falls in one of 8 sectors centred on each direction', () => {
    expect([0, 22, 23, 90, 180, 200, 270, 337, 338, 359, -10, 720].map(dirWord)).toEqual([
      'north', 'north', 'northeast', 'east', 'south', 'south', 'west', 'northwest', 'north', 'north', 'north', 'north',
    ]);
    expect(DIRECTIONS).toHaveLength(8);
  });

  it('a spot with no street is named by its direction', () => {
    expect(spotTitle(problemSpot())).toBe('Dexter Ave N');
    expect(spotTitle(problemSpot({ label: null, headingDeg: 92 }))).toBe('Spot heading east');
  });

  it('how often: every one, or some of the last ones', () => {
    expect(howOften(problemSpot({ recentHits: 4, recentPasses: 6 }))).toBe('4 of your last 6 drives here');
    expect(howOften(problemSpot({ recentHits: 3, recentPasses: 3 }))).toBe('Your last 3 drives here');
  });

  it('what happens, in the driver units', () => {
    expect(whatHappens(problemSpot(), 'mi')).toBe('Over the 35 mph limit');
    expect(whatHappens(problemSpot(), 'km')).toBe('Over the 56 km/h limit');
    expect(whatHappens(problemSpot({ limitMph: null }), 'mi')).toBe('Over the speed limit');
    expect(whatHappens(problemSpot({ kind: 'hard_brake', limitMph: null }), 'mi')).toBe('Braking hard');
    expect(whatHappens(problemSpot({ kind: 'hard_corner' }), 'mi')).toBe('Turning fast');
    expect(whatHappens(problemSpot({ kind: 'hard_accel' }), 'mi')).toBe('Pulling away hard');
    expect(limitText(25, 'km')).toBe('40 km/h');
  });

  it('progress: what clears it, then the run so far and what is left', () => {
    expect(progress(problemSpot({ cleanStreak: 0, cleanNeeded: 6 }))).toEqual({ title: 'Clears after 6 clean drives in a row here', line: null });
    expect(progress(problemSpot({ cleanStreak: 1, cleanNeeded: 6 }))).toEqual({ title: '1 clean drive in a row here', line: '5 more and it clears' });
    expect(progress(problemSpot({ cleanStreak: 2, cleanNeeded: 6 }))).toEqual({ title: '2 clean drives in a row here', line: '4 more and it clears' });
  });

  it('the map chip: the street clipped to 16 characters, else the kind word', () => {
    expect(chipText(problemSpot())).toBe('Dexter Ave N');
    expect(chipText(problemSpot({ label: 'Martin Luther King Jr Way S' }))).toBe('Martin Luther K…');
    expect(chipText(problemSpot({ label: null, kind: 'hard_corner' }))).toBe('Turn');
    expect(chipText(problemSpot({ label: null, kind: 'hard_brake' }))).toBe('Braking');
  });
});

import { contrastRatio } from '@/ui/contrast';
import { progressColor, progressTrack } from '@/ui/primitives/progress';
import { plainBundle } from '@/ui/sky/palette';
import { tokens, type LeagueTier, type Signal } from '@/ui/tokens';

const AA = 4.5;
const NON_TEXT = 3;
const schemes = ['light', 'dark'] as const;
const signals: Signal[] = ['clean', 'minor', 'moderate', 'severe'];
const tiers: LeagueTier[] = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];

function expectContrast(fg: string, bg: string, min: number, what: string) {
  const r = contrastRatio(fg, bg);
  if (r < min) throw new Error(`${what}: ${fg} on ${bg} is ${r.toFixed(2)}:1, needs ${min}:1`);
}

describe.each(schemes)('%s scheme', (s) => {
  const c = tokens.color[s];
  const grounds = { bg: c.bg, surface: c.surface, surfaceRaised: c.surfaceRaised };

  test('body, muted and subtle text read on every ground', () => {
    for (const [g, bg] of Object.entries(grounds)) {
      expectContrast(c.text, bg, AA, `text on ${g}`);
      expectContrast(c.textMuted, bg, AA, `textMuted on ${g}`);
      expectContrast(c.textSubtle, bg, AA, `textSubtle on ${g}`);
    }
  });

  test('links and tinted icons (accent) read on every ground', () => {
    for (const [g, bg] of Object.entries(grounds)) expectContrast(c.accent, bg, AA, `accent on ${g}`);
  });

  test('button labels read on their fills', () => {
    expectContrast(c.accentText, c.accent, AA, 'accentText on accent');
    expectContrast(c.onPrimary, c.primary, AA, 'onPrimary on primary');
    expectContrast(c.onPrimary, c.primaryPressed, AA, 'onPrimary on primaryPressed');
    expectContrast(c.textInverse, c.danger, AA, 'destructive label');
    expectContrast(c.text, c.border, AA, 'secondary label while pressed');
    expectContrast(c.accent, c.accentFaint, AA, 'ghost label while pressed');
  });

  test('status inks read on surfaces and on their own washes', () => {
    const pairs: [string, string][] = [
      [c.success, c.successFaint],
      [c.warning, c.warningFaint],
      [c.danger, c.dangerFaint],
      [c.info, c.infoFaint],
    ];
    for (const [ink, wash] of pairs) {
      expectContrast(ink, c.surface, AA, `${ink} on surface`);
      expectContrast(ink, c.bg, AA, `${ink} on bg`);
      expectContrast(ink, wash, AA, `${ink} on its wash`);
      // Banner body text and its ghost action sit on the wash too.
      expectContrast(c.text, wash, AA, `text on ${wash}`);
      expectContrast(c.accent, wash, AA, `accent on ${wash}`);
    }
  });

  test.each(signals)('signal %s: text on grounds and wash, onFill on fill', (sig) => {
    const v = c.signal[sig];
    for (const [g, bg] of Object.entries(grounds)) expectContrast(v.text, bg, AA, `${sig}.text on ${g}`);
    expectContrast(v.text, v.faint, AA, `${sig}.text on faint`);
    expectContrast(v.onFill, v.fill, AA, `${sig}.onFill on fill`);
  });

  test.each(tiers)('tier %s: name on grounds, glyph on its face', (tier) => {
    const v = c.tier[tier];
    expectContrast(v.text, c.bg, AA, `${tier}.text on bg`);
    expectContrast(v.text, c.surface, AA, `${tier}.text on surface`);
    expectContrast(v.ink, v.face[0], AA, `${tier}.ink on face top`);
    expectContrast(v.ink, v.face[1], NON_TEXT, `${tier}.ink on face bottom`);
  });

  test('avatar initials read on every avatar colour', () => {
    expect(c.avatar.length).toBeGreaterThanOrEqual(6);
    for (const bg of c.avatar) expectContrast(c.avatarInk, bg, AA, `avatarInk on ${bg}`);
  });

  test('freeze flakes and the at-risk / frozen streak glyphs read', () => {
    expectContrast(c.freeze, c.bg, AA, 'freeze on bg');
    expectContrast(c.freeze, c.surface, AA, 'freeze on surface');
    expectContrast(c.freeze, c.infoFaint, NON_TEXT, 'freeze on infoFaint');
    expectContrast(c.warning, c.warningFaint, NON_TEXT, 'warning glyph on warningFaint');
    expectContrast(c.textSubtle, c.surfaceRaised, NON_TEXT, 'empty flame on raised');
  });

  test('a gold Pill reads on its wash', () => {
    const fg = s === 'dark' ? c.gold : c.accent;
    expectContrast(fg, c.accentFaint, AA, 'gold pill');
    expectContrast(c.textMuted, c.surfaceRaised, AA, 'neutral pill');
    expectContrast(c.textInverse, c.text, AA, 'neutral solid pill');
  });

  test('progress fills clear 3:1 against their track', () => {
    const track = progressTrack(c, s);
    for (const tone of ['primary', 'accent', ...signals] as const)
      expectContrast(progressColor(c, tone), track, NON_TEXT, `progress ${tone}`);
  });

  test('a selected segment reads on its thumb, an unselected one on the track', () => {
    const thumb = c.primary;
    const label = c.onPrimary;
    expectContrast(label, thumb, AA, 'selected segment');
    expectContrast(c.textMuted, c.surfaceRaised, AA, 'unselected segment');
  });

  test('a strong rule reads as an edge on the app background', () => {
    expectContrast(c.borderStrong, c.bg, NON_TEXT, 'borderStrong on bg');
  });
});

test.each(schemes)('the %s scene card carries its scene palette at AA on every stop', (s) => {
  const b = plainBundle(s);
  const d = b.onScene;
  for (const stop of b.sky.scene) {
    for (const ink of [d.text, d.textMuted, d.textSubtle, d.accent])
      expectContrast(ink, stop, AA, `hero ink ${ink}`);
    for (const sig of signals) expectContrast(d.signal[sig].text, stop, AA, `hero ${sig}`);
    expectContrast(progressColor(d, 'primary'), d.border, NON_TEXT, 'hero progress');
  }
});

test('HUD is true black with AAA text', () => {
  expect(tokens.color.hud.bg).toBe('#000000');
  expect(contrastRatio(tokens.color.hud.text, tokens.color.hud.bg)).toBeGreaterThanOrEqual(7);
  expect(contrastRatio(tokens.color.hud.limitInk, tokens.color.hud.limitFace)).toBeGreaterThanOrEqual(7);
});

test('type scale: body 17, a display ≥ 34, a hero above the display, nothing under 11', () => {
  expect(tokens.type.body.fontSize).toBe(17);
  expect(tokens.type.display.fontSize).toBeGreaterThanOrEqual(34);
  expect(tokens.type.hero.fontSize).toBeGreaterThan(tokens.type.display.fontSize);
  for (const v of Object.values(tokens.type)) {
    expect(v.fontSize).toBeGreaterThanOrEqual(11);
    expect(v.lineHeight).toBeGreaterThanOrEqual(v.fontSize);
  }
});

test('every number style uses tabular figures so counters do not jitter', () => {
  for (const v of [tokens.type.hero, tokens.type.display, tokens.type.stat])
    expect(v.fontVariant).toContain('tabular-nums');
});

test('space scale is a 4-pt system', () => {
  for (const v of Object.values(tokens.space)) expect(v % 4).toBe(0);
});

test('touch targets hold the 44 / 64 pt floors', () => {
  expect(tokens.size.touch).toBeGreaterThanOrEqual(44);
  expect(tokens.size.hud).toBeGreaterThanOrEqual(64);
});

test('motion: feedback is quick, the count-up lands inside a second', () => {
  expect(tokens.motion.fast).toBeLessThanOrEqual(150);
  expect(tokens.motion.countUp).toBeLessThanOrEqual(1000);
  expect(tokens.motion.shake).toBeLessThanOrEqual(500);
});

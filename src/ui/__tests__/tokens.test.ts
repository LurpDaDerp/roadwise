import { contrastRatio } from '@/ui/contrast';
import { tokens } from '@/ui/tokens';

const schemes = ['light', 'dark'] as const;
for (const s of schemes) {
  const c = tokens.color[s];
  test(`${s}: text on bg >= 4.5:1`, () =>
    expect(contrastRatio(c.text, c.bg)).toBeGreaterThanOrEqual(4.5));
  test(`${s}: text on surface >= 4.5:1`, () =>
    expect(contrastRatio(c.text, c.surface)).toBeGreaterThanOrEqual(4.5));
  test(`${s}: muted text on surface >= 4.5:1`, () =>
    expect(contrastRatio(c.textMuted, c.surface)).toBeGreaterThanOrEqual(4.5));
  test(`${s}: accentText on accent >= 4.5:1`, () =>
    expect(contrastRatio(c.accentText, c.accent)).toBeGreaterThanOrEqual(4.5));
  test(`${s}: danger on surface >= 3:1 (non-text UI)`, () =>
    expect(contrastRatio(c.danger, c.surface)).toBeGreaterThanOrEqual(3));
}
test('HUD is true black with AAA text', () => {
  expect(tokens.color.hud.bg).toBe('#000000');
  expect(contrastRatio(tokens.color.hud.text, tokens.color.hud.bg)).toBeGreaterThanOrEqual(7);
  expect(
    contrastRatio(tokens.color.hud.limitInk, tokens.color.hud.limitFace)
  ).toBeGreaterThanOrEqual(7);
});
test('type scale has body 17 and a display >= 34', () => {
  expect(tokens.type.body.fontSize).toBe(17);
  expect(tokens.type.display.fontSize).toBeGreaterThanOrEqual(34);
});
test('space scale is a 4-pt system', () => {
  for (const v of Object.values(tokens.space)) expect(v % 4).toBe(0);
});
test('the licence stamp is legible on a card face and the laminate sheen is a triple', () => {
  for (const s of schemes) {
    const c = tokens.color[s];
    expect(contrastRatio(c.stamp, c.surface)).toBeGreaterThanOrEqual(4.5);
    expect(c.sheen).toHaveLength(3);
  }
});
test('a strong rule reads as an edge on the app background', () => {
  for (const s of schemes) {
    const c = tokens.color[s];
    expect(contrastRatio(c.borderStrong, c.bg)).toBeGreaterThanOrEqual(3);
  }
});

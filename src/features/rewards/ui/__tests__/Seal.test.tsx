import { render, screen } from '@testing-library/react-native';
import { StyleSheet, type ViewStyle } from 'react-native';

import { tokens } from '@/ui/tokens';

import { Seal, SEAL_RINGS, SEAL_THUMP_SCALE } from '../Seal';

// Reduce motion has to be known at the first render for "static" to mean anything, so the theme is
// stubbed rather than waiting on the provider's async read (as the Stamp's own test does).
const mockReduceMotion = jest.fn(() => false);
jest.mock('@/ui/theme', () => {
  const actual = jest.requireActual<typeof import('@/ui/theme')>('@/ui/theme');
  const { tokens: tk } = jest.requireActual<typeof import('@/ui/tokens')>('@/ui/tokens');
  return {
    ...actual,
    useTheme: () => ({
      scheme: 'light',
      colors: tk.color.light,
      hud: tk.color.hud,
      type: tk.type,
      space: tk.space,
      radius: tk.radius,
      motion: tk.motion,
      reduceMotion: mockReduceMotion(),
    }),
  };
});

beforeEach(() => mockReduceMotion.mockReturnValue(false));

const styleOf = (testID: string): ViewStyle => StyleSheet.flatten(screen.getByTestId(testID).props.style as ViewStyle);

const rings = (testID: string) => screen.queryAllByTestId(new RegExp(`^${testID}-ring-\\d$`));

describe('Seal', () => {
  it.each([
    ['bronze', 1, 'Bronze'],
    ['silver', 2, 'Silver'],
    ['gold', 3, 'Gold'],
  ] as const)('%s: %i ring(s) and the tier printed as a word — never colour alone', async (tier, count, word) => {
    await render(<Seal tier={tier} earned glyph="ribbon-outline" label={`Safe Start, ${word} badge`} testID="seal" />);
    expect(SEAL_RINGS[tier]).toBe(count);
    expect(rings('seal')).toHaveLength(count);
    expect(screen.getByText(word)).toBeTruthy();
    expect(screen.getByTestId('seal').props.accessibilityLabel).toContain(word);
    expect(screen.getByTestId('seal').props.accessibilityRole).toBe('image');
  });

  it('every tier inks its rings the same colour: the count and the word carry the tier', async () => {
    await render(
      <>
        <Seal tier="bronze" earned glyph="ribbon-outline" label="a" testID="b" />
        <Seal tier="gold" earned glyph="ribbon-outline" label="c" testID="g" />
      </>
    );
    const colours = new Set([...rings('b'), ...rings('g')].map((r) => StyleSheet.flatten(r.props.style).borderColor));
    expect(colours).toEqual(new Set([tokens.color.light.accent]));
  });

  it('locked: a dashed outline and the word "Locked", the tier still counted', async () => {
    await render(<Seal tier="silver" earned={false} glyph="ribbon-outline" label="x, Silver badge, locked" testID="seal" />);
    expect(screen.getByText('Locked')).toBeTruthy();
    expect(rings('seal')).toHaveLength(2);
    for (const r of rings('seal')) expect(StyleSheet.flatten(r.props.style).borderStyle).toBe('dashed');
  });

  it('a badge first seen thumps in from 1.15×', async () => {
    await render(<Seal tier="gold" earned glyph="ribbon-outline" label="x" animate testID="seal" />);
    expect(styleOf('seal').transform).toEqual([{ scale: SEAL_THUMP_SCALE }]);
  });

  it('under reduce motion a fresh seal is simply there: no transform, no animation', async () => {
    mockReduceMotion.mockReturnValue(true);
    await render(<Seal tier="gold" earned glyph="ribbon-outline" label="x" animate testID="seal" />);
    expect(styleOf('seal').transform).toBeUndefined();
  });

  it('a seal already seen is static', async () => {
    await render(<Seal tier="gold" earned glyph="ribbon-outline" label="x" testID="seal" />);
    expect(styleOf('seal').transform).toBeUndefined();
  });

  it('inside a pressable that speaks for it, the seal hides itself from the screen reader', async () => {
    await render(<Seal tier="gold" earned glyph="ribbon-outline" label="x" accessible={false} testID="seal" />);
    const seal = screen.getByTestId('seal', { includeHiddenElements: true });
    expect(seal.props.accessible).toBe(false);
    expect(seal.props.accessibilityElementsHidden).toBe(true);
  });
});

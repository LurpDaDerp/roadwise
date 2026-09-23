import { render, screen } from '@testing-library/react-native';
import { StyleSheet, type TextStyle } from 'react-native';

import { tokens } from '@/ui/tokens';
import { ThemeProvider } from '@/ui/theme';

import { progressRow, snapshot } from '../../__fixtures__/rows';
import { HubCard } from '../RewardsHubScreen';

// 200 % Dynamic Type: the largest size `Text` honours.
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 3, fontScale: 2 }),
}));

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

describe('the hub card at 200 % Dynamic Type', () => {
  async function renderCard() {
    await render(
      <ThemeProvider scheme="light">
        <HubCard snapshot={snapshot({ progress: progressRow({ points: 12450, xp: 12450, level: 4, streak_days: 112, best_streak: 112, shields: 2 }) })} />
      </ThemeProvider>
    );
  }

  it('every line doubles and none is clipped or truncated', async () => {
    await renderCard();
    const texts = screen.queryAllByText(/./, { includeHiddenElements: true });
    expect(texts.length).toBeGreaterThan(5);
    for (const t of texts) {
      expect(t.props.numberOfLines).toBeUndefined();
      expect(t.props.adjustsFontSizeToFit).toBeUndefined();
    }
    const points = StyleSheet.flatten(screen.getByTestId('hub-points-value').props.style) as TextStyle;
    expect(points.fontSize).toBe(tokens.type.display.fontSize * 2);
    expect(points.lineHeight).toBe(tokens.type.display.lineHeight * 2);
  });

  it('the fields wrap onto new lines rather than squeezing', async () => {
    await renderCard();
    expect(StyleSheet.flatten(screen.getByTestId('hub-card-fields').props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
  });

  it('snapshot', async () => {
    await renderCard();
    expect(screen.toJSON()).toMatchSnapshot();
  });
});

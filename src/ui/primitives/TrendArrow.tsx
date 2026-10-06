import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import { useTheme } from '../theme';
import type { IconName } from './Button';

export type TrendDirection = 'up' | 'down' | 'flat';

export type TrendArrowProps = {
  direction: TrendDirection;
  /** Which way is good for this metric. Safety Rating: `up`. Events per 100 mi: `down`. Default `up`. */
  better?: 'up' | 'down';
  size?: number;
  /** Default "Up, better" / "Down, worse" / "No change". */
  accessibilityLabel?: string;
  testID?: string;
};

const GLYPH: Record<TrendDirection, IconName> = { up: 'arrow-up', down: 'arrow-down', flat: 'remove' };

/** Whether a move in `direction` is good news. `null` when flat. */
export function trendIsBetter(direction: TrendDirection, better: 'up' | 'down'): boolean | null {
  return direction === 'flat' ? null : direction === better;
}

export function describeTrend(direction: TrendDirection, better: 'up' | 'down'): string {
  const good = trendIsBetter(direction, better);
  if (good === null) return 'No change';
  return `${direction === 'up' ? 'Up' : 'Down'}, ${good ? 'better' : 'worse'}`;
}

/** An arrow on a tinted disc: green when the move is good, red when it is not, grey when flat. */
export function TrendArrow({ direction, better = 'up', size = 20, accessibilityLabel, testID }: TrendArrowProps) {
  const t = useTheme();
  const good = trendIsBetter(direction, better);
  const s = good === null ? null : t.colors.signal[good ? 'clean' : 'severe'];
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={accessibilityLabel ?? describeTrend(direction, better)}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: s ? s.faint : t.colors.surfaceRaised,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Ionicons name={GLYPH[direction]} size={Math.round(size * 0.7)} color={s ? s.text : t.colors.textSubtle} />
    </View>
  );
}

import { Pressable, View } from 'react-native';

import { Text, useTheme } from '@/ui';

import { insightsCopy as copy } from './copy';
import { PERIOD_OPTIONS, type InsightsPeriod } from './period';

/**
 * The window every number on the screen is read over (§7.E E1: 4 wk / 3 mo / 12 mo / all).
 *
 * Endorsement codes on a licence: four small-caps chips over the card, the current one printed in
 * ID blue. A wrapping row rather than a fixed segmented control, so at 200 % text the chips stack
 * instead of crushing "12 mo" to one glyph. Each chip is a radio, so a screen reader announces
 * both the choice and which one is taken.
 */
export function PeriodSelector({
  value,
  onChange,
  testID,
}: {
  value: InsightsPeriod;
  onChange: (period: InsightsPeriod) => void;
  testID?: string;
}) {
  const th = useTheme();

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={copy.period.label}
      testID={testID}
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.sm }}
    >
      {PERIOD_OPTIONS.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={testID ? `${testID}-${option.value}` : undefined}
            accessibilityRole="radio"
            accessibilityLabel={option.spoken}
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            hitSlop={th.space.xs}
            style={({ pressed }) => ({
              minHeight: 44,
              justifyContent: 'center',
              paddingHorizontal: th.space.lg,
              borderRadius: th.radius.sm,
              borderWidth: selected ? 0 : 1,
              borderColor: th.colors.borderStrong,
              backgroundColor: selected
                ? th.colors.accent
                : pressed
                  ? th.colors.surfaceRaised
                  : 'transparent',
            })}
          >
            <Text
              variant="footnote"
              style={{
                color: selected ? th.colors.accentText : th.colors.text,
                textTransform: 'uppercase',
                letterSpacing: 1.2,
              }}
            >
              {option.short}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

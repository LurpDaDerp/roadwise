import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { fontFamilies, Text, useTheme } from '@/ui';

/**
 * A printed field on the licence: the small-caps label sits over a hairline, the value under it.
 * The label names the value for sighted readers and for the rotor alike; it is never a heading,
 * so the screen's heading order stays flat and scannable.
 *
 * Deliberately the same construction the trip screens use. The two are not shared yet because the
 * features are owned separately; when one of them moves into `src/ui`, the other should follow.
 */
export function Field({
  label,
  children,
  style,
  testID,
}: {
  label: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <View style={[{ gap: th.space.sm }, style]} testID={testID}>
      <Text
        variant="caption"
        tone="subtle"
        style={{
          textTransform: 'uppercase',
          letterSpacing: 1.2,
          paddingBottom: 2,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: th.colors.borderStrong,
        }}
      >
        {label}
      </Text>
      {children}
    </View>
  );
}

/**
 * A value printed in the licence face rather than the UI face. `numeral` takes B612 Mono with
 * tabular figures, so a column of rates lines up; `field` takes B612 for words.
 */
export function FieldText({
  face = 'field',
  variant = 'body',
  style,
  ...rest
}: Omit<React.ComponentProps<typeof Text>, 'style'> & {
  face?: 'field' | 'numeral';
  style?: StyleProp<TextStyle>;
}) {
  const family = face === 'numeral' ? fontFamilies.numerals : fontFamilies.field;
  const figures: TextStyle = face === 'numeral' ? { fontVariant: ['tabular-nums'] } : {};
  return <Text variant={variant} {...rest} style={[{ fontFamily: family }, figures, style]} />;
}

/**
 * One ruled row of the record: a name on the left, a value on the right, a hairline above every
 * row but the first. One accessible element, so the row reads in a single swipe.
 */
export function Rule({
  label,
  first = false,
  children,
  testID,
}: {
  label: string;
  first?: boolean;
  children: ReactNode;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space.md,
        minHeight: 44,
        paddingVertical: th.space.sm,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: th.colors.divider,
      }}
    >
      {children}
    </View>
  );
}

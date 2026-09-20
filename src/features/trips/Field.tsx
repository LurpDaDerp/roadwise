import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { fontFamilies, Text, useTheme } from '@/ui';

/**
 * A printed field on the licence: the small-caps label sits over a hairline, the value under it.
 * The label names the value for sighted readers and for the rotor alike; it is never a heading.
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
    <View style={[{ gap: th.space.xs }, style]} testID={testID}>
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
 * tabular figures, so a column of splits lines up; `field` takes B612 for words.
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

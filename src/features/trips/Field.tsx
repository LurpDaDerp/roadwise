import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { fontFamilies, Text, useTheme, type TypeScale } from '@/ui';

import { TIGHT } from './layout';

/** Small caps need air between the letters or the word closes up; this is the field-label step. */
const LABEL_TRACKING = 1.2;

/**
 * The type steps that already name a weighted face. `FieldText` swaps the family for the licence
 * face, so without this list `<FieldText variant="title2">` would print B612 **Regular** beside a
 * `<Text variant="title2">` printing B612 Bold — same size, same card, different weight
 * (Task 6 review, M-9).
 */
const BOLD_VARIANTS: readonly (keyof TypeScale)[] = [
  'display',
  'title1',
  'title2',
  // These two name the UI face at weight 600. Swapping in the licence face leaves the weight with
  // no matching cut to resolve to, so they take the bold face as well (Task 7 review, M-4).
  'title3',
  'headline',
];

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
          letterSpacing: LABEL_TRACKING,
          paddingBottom: TIGHT,
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
  const bold = BOLD_VARIANTS.includes(variant);
  const family =
    face === 'numeral'
      ? bold
        ? fontFamilies.numeralsBold
        : fontFamilies.numerals
      : bold
        ? fontFamilies.fieldBold
        : fontFamilies.field;
  const figures: TextStyle = face === 'numeral' ? { fontVariant: ['tabular-nums'] } : {};
  return <Text variant={variant} {...rest} style={[{ fontFamily: family }, figures, style]} />;
}

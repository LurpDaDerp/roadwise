import { TextInput, useWindowDimensions, type TextInputProps } from 'react-native';

import { useTheme } from '@/ui';

/**
 * One text field of the email sign-in screens: its label is its placeholder and its accessibility
 * label, it never capitalises or corrects what is typed, and it grows with the text size (to 2×).
 */
export function AuthField({ label, ...props }: Omit<TextInputProps, 'style' | 'placeholder'> & { label: string }) {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  return (
    <TextInput
      accessibilityLabel={label}
      placeholder={label}
      placeholderTextColor={th.colors.textMuted}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      {...props}
      style={{
        minHeight: 48 * scale,
        borderWidth: 1.5,
        borderColor: th.colors.borderStrong,
        borderRadius: th.radius.md,
        paddingHorizontal: th.space.md,
        color: th.colors.text,
        fontSize: 17 * scale,
      }}
    />
  );
}

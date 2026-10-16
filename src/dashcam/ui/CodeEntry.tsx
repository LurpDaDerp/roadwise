import { useState } from 'react';
import { TextInput, View } from 'react-native';

import { Button, Text, useFontScale, useTheme } from '@/ui';

import { dashpalCopy } from '../copy';

const copy = dashpalCopy.setup;

/**
 * Typing the 28 characters printed under the label's QR code (case, spaces and dashes do not
 * matter), and optionally the 4 characters of its name (`DashPal-____`), which lets the phone find
 * that DashPal at once instead of trying the code on each one nearby.
 */
export function CodeEntry({ onSubmit }: { onSubmit(code: string, name: string): void }) {
  const th = useTheme();
  const scale = useFontScale();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const field = {
    minHeight: 48 * scale,
    paddingHorizontal: th.space.md,
    borderRadius: th.radius.card,
    backgroundColor: th.colors.surface,
    borderWidth: 1.5,
    borderColor: th.colors.border,
    color: th.colors.text,
    fontSize: 17 * scale,
  } as const;
  return (
    <View style={{ gap: th.space.sm }} testID="setup-entry">
      <Text variant="subhead">{copy.codeLabel}</Text>
      <TextInput
        testID="setup-code-input"
        accessibilityLabel={copy.codeLabel}
        value={code}
        onChangeText={setCode}
        placeholder={copy.codePlaceholder}
        placeholderTextColor={th.colors.textSubtle}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        maxLength={48}
        allowFontScaling={false}
        style={field}
      />
      <Text variant="subhead">{copy.nameLabel}</Text>
      <TextInput
        testID="setup-name-input"
        accessibilityLabel={copy.nameLabel}
        value={name}
        onChangeText={setName}
        placeholder="XXXX"
        placeholderTextColor={th.colors.textSubtle}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        maxLength={4}
        allowFontScaling={false}
        style={field}
      />
      <Button label={copy.submit} disabled={code.trim().length === 0} onPress={() => onSubmit(code, name)} testID="setup-code-submit" />
    </View>
  );
}

import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import { useTheme } from '../theme';
import { Button } from './Button';
import { Text } from './Text';

export type BannerTone = 'info' | 'success' | 'warning' | 'danger';

type Props = {
  tone: BannerTone;
  message: string;
  action?: { label: string; onPress: () => void };
  testID?: string;
};

/** Each tone carries a drawn glyph as well as its ink, so the meaning never rides on colour. */
const GLYPH: Record<BannerTone, keyof typeof Ionicons.glyphMap> = {
  info: 'information-circle',
  success: 'checkmark-circle',
  warning: 'alert-circle',
  danger: 'close-circle',
};

export function Banner({ tone, message, action, testID }: Props) {
  const t = useTheme();
  const ink = {
    info: t.colors.info,
    success: t.colors.success,
    warning: t.colors.warning,
    danger: t.colors.danger,
  }[tone];
  const wash = {
    info: t.colors.infoFaint,
    success: t.colors.successFaint,
    warning: t.colors.warningFaint,
    danger: t.colors.dangerFaint,
  }[tone];

  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      style={{
        backgroundColor: wash,
        borderRadius: t.radius.md,
        borderWidth: 1,
        borderColor: ink,
        padding: t.space.md,
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.space.md,
      }}
    >
      <Ionicons name={GLYPH[tone]} size={20} color={ink} />
      <Text variant="subhead" style={{ flex: 1 }}>
        {message}
      </Text>
      {action ? (
        <Button label={action.label} onPress={action.onPress} variant="ghost" size="md" />
      ) : null}
    </View>
  );
}

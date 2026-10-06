import { Ionicons } from '@expo/vector-icons';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';
import type { Signal } from '../tokens';
import type { IconName } from './Button';
import { Text } from './Text';

export type PillTone = 'neutral' | 'accent' | 'gold' | 'info' | Signal;

export type PillProps = {
  label: string;
  /** `clean` / `minor` / `moderate` / `severe` for events and stat health. Default `neutral`. */
  tone?: PillTone;
  /** Always pass one for a signal tone, so the meaning is not colour alone. */
  icon?: IconName;
  /** `solid` uses the fill colour (loud: "CLEAN DRIVE"); `soft` (default) a faint wash. */
  emphasis?: 'soft' | 'solid';
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** A static label in a capsule: event tier, "Clean", "Promotion zone", "×1.25". Not tappable. */
export function Pill({ label, tone = 'neutral', icon, emphasis = 'soft', style, testID }: PillProps) {
  const t = useTheme();
  const c = t.colors;
  let bg: string;
  let fg: string;
  if (tone === 'neutral') {
    bg = emphasis === 'solid' ? c.text : c.surfaceRaised;
    fg = emphasis === 'solid' ? c.textInverse : c.textMuted;
  } else if (tone === 'accent') {
    bg = emphasis === 'solid' ? c.accent : c.accentFaint;
    fg = emphasis === 'solid' ? c.accentText : c.accent;
  } else if (tone === 'gold') {
    bg = emphasis === 'solid' ? c.primary : c.accentFaint;
    fg = emphasis === 'solid' ? c.onPrimary : t.scheme === 'dark' ? c.gold : c.accent;
  } else if (tone === 'info') {
    bg = emphasis === 'solid' ? c.info : c.infoFaint;
    fg = emphasis === 'solid' ? c.textInverse : c.info;
  } else {
    const s = c.signal[tone];
    bg = emphasis === 'solid' ? s.fill : s.faint;
    fg = emphasis === 'solid' ? s.onFill : s.text;
  }

  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={label}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'flex-start',
          gap: t.space.xs,
          paddingHorizontal: t.space.sm + 2,
          paddingVertical: 3,
          borderRadius: t.radius.pill,
          backgroundColor: bg,
        },
        style,
      ]}
    >
      {icon ? <Ionicons name={icon} size={14} color={fg} /> : null}
      <Text variant="label" style={{ color: fg }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

import { View } from 'react-native';

import { useTheme } from '../theme';
import { Text } from './Text';

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';
export const AVATAR_PT: Record<AvatarSize, number> = { sm: 32, md: 40, lg: 56, xl: 88 };

/**
 * One or two letters from a username: the first letters of its first two words, where words are
 * split on `_ - . space`, digits and camelCase ("maya_drives" → "MD", "LurpDaDerp" → "LD",
 * "jordan" → "J"). Falls back to "?" for a name with no letters.
 */
export function avatarInitials(username: string): string {
  const words = username
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.\d]+/)
    .filter((w) => /\p{L}/u.test(w));
  if (words.length === 0) return '?';
  const first = (w: string) => (w.match(/\p{L}/u)?.[0] ?? '').toUpperCase();
  return words.length === 1 ? first(words[0]!) : first(words[0]!) + first(words[1]!);
}

/** A stable palette slot for a username (case-insensitive djb2 hash). */
export function avatarColorIndex(username: string, paletteSize: number): number {
  let h = 5381;
  for (const ch of username.toLowerCase()) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % paletteSize;
}

export type AvatarProps = {
  username: string;
  /** sm 32 · md 40 · lg 56 · xl 88. Default `md`. */
  size?: AvatarSize;
  /**
   * Avatars are decorative by default (the username is always printed beside them). Pass a label
   * only when the avatar stands alone.
   */
  accessibilityLabel?: string;
  testID?: string;
};

/** Initials on a colour picked from the username. No photos, ever (teen safety). */
export function Avatar({ username, size = 'md', accessibilityLabel, testID }: AvatarProps) {
  const t = useTheme();
  const d = AVATAR_PT[size];
  const bg = t.colors.avatar[avatarColorIndex(username, t.colors.avatar.length)]!;

  return (
    <View
      testID={testID}
      accessible={!!accessibilityLabel}
      accessibilityLabel={accessibilityLabel}
      importantForAccessibility={accessibilityLabel ? 'yes' : 'no-hide-descendants'}
      accessibilityElementsHidden={!accessibilityLabel}
      style={{
        width: d,
        height: d,
        borderRadius: d / 2,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        allowFontScaling={false}
        style={{
          fontFamily: t.type.display.fontFamily,
          fontSize: Math.round(d * 0.4),
          lineHeight: Math.round(d * 0.48),
          color: t.colors.avatarInk,
        }}
      >
        {avatarInitials(username)}
      </Text>
    </View>
  );
}

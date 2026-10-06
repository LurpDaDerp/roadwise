import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';

import { useDrive } from '@/drive/useDrive';
import { Text, useTheme } from '@/ui';

import { DRIVE_HREF, hudCopy } from './hudCopy';

/**
 * A strip for in-app screens while a drive is recording (reached from a notification tap at a
 * stop): one tap goes back to the driving screen. Nothing else — the drive is ended there.
 */
export function DriveInProgressBanner() {
  const th = useTheme();
  const router = useRouter();
  const recording = useDrive((d) => d.status === 'recording');
  if (!recording) return null;

  return (
    <Pressable
      testID="drive-in-progress"
      accessibilityRole="button"
      accessibilityLabel={hudCopy.banner.label}
      onPress={() => router.navigate(DRIVE_HREF)}
      style={({ pressed }) => ({
        minHeight: th.size.touch,
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space.sm,
        paddingHorizontal: th.space.lg,
        paddingVertical: th.space.sm,
        borderRadius: th.radius.pill,
        borderCurve: 'continuous',
        backgroundColor: pressed ? th.colors.surfaceRaised : th.colors.surface,
        borderWidth: 1.5,
        borderColor: th.colors.accent,
      })}
    >
      <Ionicons name="radio-button-on" size={th.size.icon} color={th.colors.danger} />
      <View style={{ flex: 1 }}>
        <Text variant="headline">{hudCopy.banner.title}</Text>
      </View>
      <Text variant="subhead" tone="accent">
        {hudCopy.banner.action}
      </Text>
      <Ionicons name="chevron-forward" size={th.size.icon} color={th.colors.accent} />
    </Pressable>
  );
}

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';

import { useDrive } from '@/drive/useDrive';
import { Text, useTheme } from '@/ui';

import { DRIVE_HREF, hudCopy } from './hudCopy';

/**
 * A strip for in-app screens while a drive is recording (reached from a notification tap at a
 * stop), or while a Start drive swipe waits for the car to move: one tap goes back to the driving
 * screen. Nothing else: the drive is ended (or the wait stopped) there.
 */
export function DriveInProgressBanner() {
  const th = useTheme();
  const router = useRouter();
  const state = useDrive((d) => (d.status === 'recording' ? 'recording' : d.waiting !== null && d.status === 'idle' ? 'waiting' : null));
  if (state === null) return null;
  const waiting = state === 'waiting';

  return (
    <Pressable
      testID="drive-in-progress"
      accessibilityRole="button"
      accessibilityLabel={waiting ? hudCopy.banner.waitingLabel : hudCopy.banner.label}
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
      {waiting ? (
        <Ionicons testID="drive-in-progress-waiting" name="car-sport" size={th.size.icon} color={th.colors.accent} />
      ) : (
        <Ionicons name="radio-button-on" size={th.size.icon} color={th.colors.danger} />
      )}
      <View style={{ flex: 1 }}>
        <Text variant="headline">{waiting ? hudCopy.banner.waitingTitle : hudCopy.banner.title}</Text>
      </View>
      <Text variant="subhead" tone="accent">
        {waiting ? hudCopy.banner.waitingAction : hudCopy.banner.action}
      </Text>
      <Ionicons name="chevron-forward" size={th.size.icon} color={th.colors.accent} />
    </Pressable>
  );
}

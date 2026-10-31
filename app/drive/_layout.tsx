import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { HudCrashed } from '@/features/drive/HudCrashed';

/**
 * A driving screen that throws while drawing shows "Something went wrong" with one 64 pt Try again,
 * on the HUD's black, and the error goes to the crash sink. The drive keeps recording behind it.
 */
export { HudCrashed as ErrorBoundary };

/**
 * The driving screen. The root stack presents this group as a full-screen modal with no swipe-back:
 * a drive is left only through its own End control. The driving screen is true black whatever
 * the hour, so its status bar is always light, whatever the app's sky says elsewhere.
 */
export default function DriveLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, gestureEnabled: false, orientation: 'portrait' }}>
        <Stack.Screen name="index" options={{ orientation: 'all', animation: 'fade' }} />
      </Stack>
    </>
  );
}

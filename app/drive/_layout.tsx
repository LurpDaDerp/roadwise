import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

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

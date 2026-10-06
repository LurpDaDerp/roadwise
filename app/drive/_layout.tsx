import { Stack } from 'expo-router';

/**
 * The driving screen. The root stack presents this group as a full-screen modal with no swipe-back:
 * a drive is left only through its own End control.
 */
export default function DriveLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, gestureEnabled: false, orientation: 'portrait' }}>
      <Stack.Screen name="index" options={{ orientation: 'all', animation: 'fade' }} />
    </Stack>
  );
}

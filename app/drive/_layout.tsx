import { Stack } from 'expo-router';

/**
 * The drive group: the pre-drive sheet (`start`, U3), the HUD (`hud`), the pocket screen (`pocket`)
 * and the end screen (`end`, U3). H2 presents the whole group as a full-screen modal from the root.
 *
 * No swipe-back anywhere in it — a drive screen is left through its own controls, never a stray
 * edge swipe (Android back is swallowed by the lockout gate while a trip records). The root stack
 * pins portrait; only the HUD may turn, because a dash mount may be landscape (rev1: I17).
 */
export default function DriveLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, gestureEnabled: false, orientation: 'portrait' }}>
      <Stack.Screen name="hud" options={{ orientation: 'all', animation: 'fade' }} />
      <Stack.Screen name="pocket" options={{ animation: 'fade' }} />
    </Stack>
  );
}

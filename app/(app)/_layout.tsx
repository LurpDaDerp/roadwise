import { Stack } from 'expo-router';

/**
 * The signed-in screens that live outside the tab bar: a trip's card back and the pages behind
 * it. No native headers — each screen prints its own title and carries its own Back, as the
 * auth group does — and the swipe-back gesture still works.
 */
export default function AppLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}

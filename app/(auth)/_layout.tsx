import { Stack } from 'expo-router';

/** The signed-out group: the one sign-in screen, which carries its own title. */
export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}

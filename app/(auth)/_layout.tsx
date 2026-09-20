import { Stack } from 'expo-router';

/** The signed-out group. No headers: Welcome and Sign in carry their own titles. */
export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}

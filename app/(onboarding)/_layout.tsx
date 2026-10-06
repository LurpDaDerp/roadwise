import { Stack } from 'expo-router';

/**
 * The onboarding group: one stepper route, `[step]`. No header — each step prints its own position
 * and Back — and no swipe-back: going back is the step's Back, which never returns into the
 * username step once it is claimed.
 */
export default function OnboardingLayout() {
  return <Stack screenOptions={{ headerShown: false, gestureEnabled: false }} />;
}

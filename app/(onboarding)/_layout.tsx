import { Stack } from 'expo-router';

/**
 * The onboarding group: one stepper route, `[step]`. No header — each step prints its own position
 * and Back — and no swipe-back: going back is the step's Back, which never returns into Terms or
 * across a confirmed birth date.
 */
export default function OnboardingLayout() {
  return <Stack screenOptions={{ headerShown: false, gestureEnabled: false }} />;
}

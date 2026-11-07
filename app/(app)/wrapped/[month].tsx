import { Stack, useLocalSearchParams } from 'expo-router';

import { WrappedMonthScreen } from '@/features/wrapped/WrappedScreens';

/** `/wrapped/<YYYY-MM>`: the driver's own Wrapped story for a past month (the push on the 1st opens it). */
export default function WrappedMonthRoute() {
  const { month } = useLocalSearchParams<{ month?: string | string[] }>();
  return (
    <>
      <Stack.Screen options={{ animation: 'slide_from_bottom' }} />
      <WrappedMonthScreen month={typeof month === 'string' ? month : ''} />
    </>
  );
}

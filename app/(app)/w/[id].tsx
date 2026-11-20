import { Stack, useLocalSearchParams } from 'expo-router';

import { SharedWrappedScreen } from '@/features/wrapped/WrappedScreens';

/** `/w/<id>`: a shared Wrapped (`roadwise://w/<id>`, or `https://getroadwise.app/w/<id>` in EAS builds), for anyone signed in. */
export default function SharedWrappedRoute() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  return (
    <>
      <Stack.Screen options={{ animation: 'slide_from_bottom' }} />
      <SharedWrappedScreen id={typeof id === 'string' ? id : ''} />
    </>
  );
}

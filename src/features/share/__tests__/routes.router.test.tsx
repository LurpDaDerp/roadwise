/**
 * The routes under the real expo-router: the root stack lists its screens the way
 * `app/_layout.tsx` does (without `join/[code]`), and the `(app)` group presents
 * `rewards/share` as a sheet. T12 carry: `/join/<code>` resolves with no `Stack.Screen` of its own.
 */
import { renderRouter, screen } from 'expo-router/testing-library';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';

import AppGroupLayout from '../../../../app/(app)/_layout';

function Params({ testID }: { testID: string }) {
  const params = useLocalSearchParams();
  return <Text testID={testID}>{JSON.stringify(params)}</Text>;
}

const RootLayout = () => (
  <Stack screenOptions={{ headerShown: false }}>
    <Stack.Screen name="index" />
    <Stack.Screen name="(tabs)" />
    <Stack.Screen name="(app)" />
  </Stack>
);

const routes = {
  _layout: RootLayout,
  index: () => <Text>home</Text>,
  '(tabs)/_layout': () => <Stack screenOptions={{ headerShown: false }} />,
  '(tabs)/rewards': () => <Text>rewards</Text>,
  // The real (app) layout, with its sheet option.
  '(app)/_layout': AppGroupLayout,
  '(app)/rewards/share': () => <Params testID="share" />,
  'join/[code]': () => <Params testID="join" />,
};

test('/join/<code> resolves under the root stack with no Stack.Screen of its own', async () => {
  await renderRouter(routes, { initialUrl: '/join/ABCD2345' });
  expect(screen.getByTestId('join').props.children).toBe(JSON.stringify({ code: 'ABCD2345' }));
});

test('/rewards/share?kind=trip&clientTripId=<id> (the D1 and D2 link) reaches the composer route with its params', async () => {
  await renderRouter(routes, { initialUrl: '/rewards/share?kind=trip&clientTripId=trip-9' });
  expect(JSON.parse(screen.getByTestId('share').props.children as string)).toEqual({ kind: 'trip', clientTripId: 'trip-9' });
});

test('/rewards/share?kind=badge&badgeId=<id> (the F3 link) likewise', async () => {
  await renderRouter(routes, { initialUrl: '/rewards/share?kind=badge&badgeId=safe_days_7' });
  expect(JSON.parse(screen.getByTestId('share').props.children as string)).toEqual({ kind: 'badge', badgeId: 'safe_days_7' });
});

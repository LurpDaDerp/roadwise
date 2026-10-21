import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { IconButton, Screen, ScreenTitle, useTheme } from '@/ui';

import { leaguesCopy } from './copy';
import { FriendsBoard } from './FriendsBoard';
import { FRIENDS_ADD_HREF } from './routes';

/**
 * The Friends tab (route `/leagues`): you and your friends ranked by Safety Rating, with a button
 * beside the title to add friends.
 */
export function LeaguesScreen() {
  const t = useTheme();
  const router = useRouter();
  return (
    <Screen padded={false} bottomInset={false} sky testID="leagues-screen">
      <View style={{ paddingHorizontal: t.space.lg, paddingTop: t.space.lg }}>
        <ScreenTitle
          testID="leagues-title"
          trailing={
            <IconButton
              icon="person-add-outline"
              variant="surface"
              accessibilityLabel={leaguesCopy.add}
              onPress={() => router.push(FRIENDS_ADD_HREF)}
              testID="leagues-add"
            />
          }
        >
          {leaguesCopy.title}
        </ScreenTitle>
      </View>
      <View style={{ flex: 1 }}>
        <FriendsBoard />
      </View>
    </Screen>
  );
}

import { useState } from 'react';
import { View } from 'react-native';

import { Screen, ScreenTitle, SegmentedControl, useTheme } from '@/ui';

import { leaguesCopy } from './copy';
import { FriendsBoard } from './FriendsBoard';
import { GlobalBoard } from './GlobalBoard';

export type LeaguesSegment = 'friends' | 'global';

const SEGMENTS = [
  { value: 'friends', label: leaguesCopy.segments.friends },
  { value: 'global', label: leaguesCopy.segments.global },
] as const;

/**
 * The Leaderboards tab (route `/leagues`): Friends (default) · Global, ranked by weekly points or
 * the Safety Rating.
 */
export function LeaguesScreen({ initial = 'friends' }: { initial?: LeaguesSegment }) {
  const t = useTheme();
  const [segment, setSegment] = useState<LeaguesSegment>(initial);

  return (
    <Screen padded={false} bottomInset={false} sky testID="leagues-screen">
      <View style={{ paddingHorizontal: t.space.lg, paddingTop: t.space.lg, gap: t.space.md }}>
        <ScreenTitle testID="leagues-title">{leaguesCopy.title}</ScreenTitle>
        <SegmentedControl
          segments={SEGMENTS}
          value={segment}
          onChange={setSegment}
          accessibilityLabel={leaguesCopy.segmentsLabel}
          testID="leagues-segments"
        />
      </View>
      <View style={{ flex: 1 }}>
        {segment === 'friends' ? <FriendsBoard /> : null}
        {segment === 'global' ? <GlobalBoard /> : null}
      </View>
    </Screen>
  );
}

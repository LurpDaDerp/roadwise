import { useState } from 'react';
import { View } from 'react-native';

import { Screen, SegmentedControl, Text, useTheme } from '@/ui';

import { leaguesCopy } from './copy';
import { FriendsBoard } from './FriendsBoard';
import { GlobalBoard } from './GlobalBoard';
import { LeagueBoard } from './LeagueBoard';

export type LeaguesSegment = 'friends' | 'league' | 'global';

const SEGMENTS = [
  { value: 'friends', label: leaguesCopy.segments.friends },
  { value: 'league', label: leaguesCopy.segments.league },
  { value: 'global', label: leaguesCopy.segments.global },
] as const;

/** The Leagues tab: Friends & clan (default) · League · Global. */
export function LeaguesScreen({ initial = 'friends' }: { initial?: LeaguesSegment }) {
  const t = useTheme();
  const [segment, setSegment] = useState<LeaguesSegment>(initial);

  return (
    <Screen padded={false} bottomInset={false} sky testID="leagues-screen">
      <View style={{ paddingHorizontal: t.space.lg, paddingTop: t.space.lg, gap: t.space.md }}>
        <Text variant="title1" accessibilityRole="header">
          {leaguesCopy.title}
        </Text>
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
        {segment === 'league' ? <LeagueBoard /> : null}
        {segment === 'global' ? <GlobalBoard /> : null}
      </View>
    </Screen>
  );
}

/**
 * Home's "Get set up" row: a few one-time things, each a tile in a row that scrolls sideways
 * (emergency contacts, your places, your car on an iPhone with the car link, DashPal, a first
 * friend). A tile shows a check once done and moves to the end; a tap opens its screen. The row
 * goes once every goal is done, and never shows during a drive.
 */
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, type ComponentProps } from 'react';
import { ScrollView, View } from 'react-native';

import type { DashcamState } from '@/dashcam/runtime';
import { useDashcamSelector } from '@/dashcam/ui/useDashcam';
import { useCarLink } from '@/features/carLink/useCarLink';
import { useEmergencyContacts } from '@/features/emergency/useEmergencyContacts';
import { FRIENDS_ADD_HREF } from '@/features/leagues/routes';
import { PLACES_QUERY, usePlaces } from '@/features/places/usePlaces';
import { SETTINGS_HREFS } from '@/features/settings/routes';
import { useFriends } from '@/features/social/api';
import { Card, ProgressRing, Text, useFontScale, useTheme } from '@/ui';

import { homeCopy } from './copy';

const copy = homeCopy.setup;

export type SetupGoalId = 'emergency' | 'places' | 'car' | 'dashpal' | 'friend';
export interface SetupGoal {
  id: SetupGoalId;
  done: boolean;
}

/** A tile's width at the default text size; it grows with larger text, up to 1.6 times. */
export const SETUP_TILE_WIDTH = 168;

const ICONS: Record<SetupGoalId, ComponentProps<typeof Ionicons>['name']> = {
  emergency: 'call',
  places: 'home',
  car: 'car-sport',
  dashpal: 'videocam',
  friend: 'person-add',
};

const HREFS: Record<SetupGoalId, Href> = {
  emergency: SETTINGS_HREFS.emergency,
  places: SETTINGS_HREFS.places,
  car: SETTINGS_HREFS.car,
  dashpal: SETTINGS_HREFS.dashcam,
  friend: FRIENDS_ADD_HREF,
};

/** The open goals first, then the done ones, each in the order given. */
export function orderGoals(goals: readonly SetupGoal[]): SetupGoal[] {
  return [...goals.filter((g) => !g.done), ...goals.filter((g) => g.done)];
}

/**
 * A DashPal is paired with this phone: false with no runtime (a build without Bluetooth), null
 * until the runtime has read its settings (not known yet).
 */
const selectDashpalPaired = (s: DashcamState | null): boolean | null => (s === null ? false : s.loaded ? s.link.paired != null : null);

function GoalTile({ goal, onPress }: { goal: SetupGoal; onPress: () => void }) {
  const t = useTheme();
  const scale = useFontScale();
  const words = copy.goals[goal.id];
  const spoken = goal.done ? copy.spokenDone(words.title, words.line) : copy.spokenOpen(words.title, words.line);
  return (
    <Card
      onPress={onPress}
      accessibilityLabel={spoken}
      accessibilityHint={words.hint}
      style={{ width: Math.round(SETUP_TILE_WIDTH * Math.min(Math.max(scale, 1), 1.6)), borderRadius: t.radius.lg }}
      testID={`home-setup-${goal.id}`}
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <ProgressRing value={goal.done ? 1 : 0} size={40} strokeWidth={5} tone={goal.done ? 'clean' : 'primary'} accessibilityLabel={spoken}>
          {goal.done ? (
            <Ionicons name="checkmark" size={t.size.icon} color={t.colors.signal.clean.text} testID={`home-setup-${goal.id}-done`} />
          ) : (
            <Ionicons name={ICONS[goal.id]} size={t.size.icon} color={t.colors.accent} />
          )}
        </ProgressRing>
      </View>
      <View style={{ gap: 2 }}>
        <Text variant="headline">{words.title}</Text>
        <Text variant="subhead" tone="muted">
          {words.line}
        </Text>
      </View>
    </Card>
  );
}

/** The row itself: "Get set up" with how many are done, then the tiles, open ones first. */
export function SetupGoalsView({ goals, onOpen }: { goals: readonly SetupGoal[]; onOpen: (id: SetupGoalId) => void }) {
  const t = useTheme();
  const done = goals.filter((g) => g.done).length;
  return (
    <View style={{ gap: t.space.sm }} testID="home-setup">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: t.space.sm }}>
          <Text variant="title3" accessibilityRole="header">
            {copy.title}
          </Text>
          <Text variant="subhead" tone="muted" accessibilityLabel={copy.progressSpoken(done, goals.length)} testID="home-setup-count">
            {copy.progress(done, goals.length)}
          </Text>
        </View>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        testID="home-setup-row"
        // Out to the screen's edges (Home's gutters), as the week's pills do.
        style={{ flexGrow: 0, marginHorizontal: -t.space.lg }}
        contentContainerStyle={{ gap: t.space.sm, paddingHorizontal: t.space.lg, paddingVertical: t.space.xs }}
      >
        {orderGoals(goals).map((g) => (
          <GoalTile key={g.id} goal={g} onPress={() => onOpen(g.id)} />
        ))}
      </ScrollView>
    </View>
  );
}

/** Home's slot: renders nothing during a drive, until what it needs is read, or once all is done. */
export function HomeSetupGoals({ hidden }: { hidden: boolean }) {
  const router = useRouter();
  const { contacts, refetch: refetchContacts } = useEmergencyContacts();
  const { places } = usePlaces();
  const client = useQueryClient();
  const car = useCarLink();
  const dashpal = useDashcamSelector(selectDashpalPaired);
  const friends = useFriends();
  // Something set up a screen deeper shows as done on the way back (the car link and friends read again on focus themselves).
  useFocusEffect(
    useCallback(() => {
      void refetchContacts();
      void client.invalidateQueries({ queryKey: PLACES_QUERY });
    }, [refetchContacts, client])
  );

  // Wait for every goal that can still be read, so a finished driver never sees the row flash in.
  const friendsLoading = friends.data === undefined && friends.status === 'pending' && friends.fetchStatus === 'fetching';
  if (hidden || contacts === undefined || places === undefined) return null;
  if (car.view.status === 'loading' || dashpal === null || friendsLoading) return null;
  const goals: SetupGoal[] = [
    { id: 'emergency', done: contacts.length > 0 },
    { id: 'places', done: places.length > 0 },
    ...(car.view.status === 'ready' ? [{ id: 'car' as const, done: car.view.state.cars.length > 0 }] : []),
    { id: 'dashpal', done: dashpal },
    // Friends that could not be read (offline, an error, signed out) leave their tile out.
    ...(friends.data ? [{ id: 'friend' as const, done: friends.data.friends.length >= 1 }] : []),
  ];
  if (goals.every((g) => g.done)) return null;
  return <SetupGoalsView goals={goals} onOpen={(id) => router.push(HREFS[id])} />;
}

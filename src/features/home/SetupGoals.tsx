/**
 * Home's "Get set up" row: a few one-time things, each a tile in a row that scrolls sideways
 * (emergency contacts, your places, your car on an iPhone with the car link, DashPal, a first
 * friend). A tap opens its screen. Each tile has a ✕ in its top right corner, a check once its goal
 * is done (the tile then moves to the end); either removes the tile for good (until a sign-out). The
 * row goes once every goal is done or every tile is removed, and never shows during a drive.
 */
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import type { DashcamState } from '@/dashcam/runtime';
import { useDashcamSelector } from '@/dashcam/ui/useDashcam';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { useCarLink } from '@/features/carLink/useCarLink';
import { useEmergencyContacts } from '@/features/emergency/useEmergencyContacts';
import { FRIENDS_ADD_HREF } from '@/features/leagues/routes';
import { PLACES_QUERY, usePlaces } from '@/features/places/usePlaces';
import { SETTINGS_HREFS } from '@/features/settings/routes';
import { useFriends } from '@/features/social/api';
import { Card, ProgressRing, Text, useFontScale, useTheme } from '@/ui';

import { homeCopy } from './copy';

const copy = homeCopy.setup;

/** The tiles removed with their ✕ or check (cleared at sign-out, `SIGN_OUT_SETTINGS`). */
export const SETUP_GOALS_HIDDEN_KEY = 'home.setupGoalsHidden';

const GOAL_IDS: readonly SetupGoalId[] = ['emergency', 'places', 'car', 'dashpal', 'friend'];

/** The stored removed tiles, read leniently (anything else: none). */
export function parseHiddenGoals(v: unknown): SetupGoalId[] {
  if (!Array.isArray(v)) return [];
  return GOAL_IDS.filter((id) => v.includes(id));
}

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

/** The tile's corner: a ✕ while its goal is open, a green check once done; either removes the tile. */
function TileCorner({ goal, onHide }: { goal: SetupGoal; onHide: () => void }) {
  const t = useTheme();
  const words = copy.goals[goal.id];
  const size = 32;
  const slop = Math.max(0, (t.size.touch - size) / 2);
  return (
    <Pressable
      testID={`home-setup-${goal.id}-hide`}
      accessibilityRole="button"
      accessibilityLabel={copy.hide(words.title)}
      accessibilityHint={copy.hideHint}
      onPress={onHide}
      hitSlop={slop}
      style={({ pressed }) => ({
        position: 'absolute',
        top: t.space.xs,
        right: t.space.xs,
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
        transform: [{ scale: pressed ? 0.94 : 1 }],
      })}
    >
      {goal.done ? (
        <Ionicons name="checkmark-circle" size={t.size.icon} color={t.colors.signal.clean.text} testID={`home-setup-${goal.id}-check`} />
      ) : (
        <Ionicons name="close" size={t.size.icon} color={t.colors.textMuted} testID={`home-setup-${goal.id}-x`} />
      )}
    </Pressable>
  );
}

function GoalTile({ goal, onPress, onHide }: { goal: SetupGoal; onPress: () => void; onHide: () => void }) {
  const t = useTheme();
  const scale = useFontScale();
  const words = copy.goals[goal.id];
  const spoken = goal.done ? copy.spokenDone(words.title, words.line) : copy.spokenOpen(words.title, words.line);
  return (
    <View>
      <Card
        onPress={onPress}
        accessibilityLabel={spoken}
        accessibilityHint={words.hint}
        style={{ width: Math.round(SETUP_TILE_WIDTH * Math.min(Math.max(scale, 1), 1.6)), borderRadius: t.radius.lg }}
        testID={`home-setup-${goal.id}`}
      >
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <ProgressRing value={goal.done ? 1 : 0} size={40} strokeWidth={5} tone={goal.done ? 'clean' : 'primary'} accessibilityLabel={spoken}>
            <Ionicons
              name={ICONS[goal.id]}
              size={t.size.icon}
              color={goal.done ? t.colors.signal.clean.text : t.colors.accent}
              testID={goal.done ? `home-setup-${goal.id}-done` : undefined}
            />
          </ProgressRing>
        </View>
        <View style={{ gap: 2 }}>
          <Text variant="headline">{words.title}</Text>
          <Text variant="subhead" tone="muted">
            {words.line}
          </Text>
        </View>
      </Card>
      <TileCorner goal={goal} onHide={onHide} />
    </View>
  );
}

/**
 * The row itself: "Get set up" with how many are done, then the tiles still shown, open ones first.
 * The count takes in removed tiles whose goal is done, and leaves out removed open ones.
 */
export function SetupGoalsView({
  goals,
  hiddenIds = [],
  onOpen,
  onHide,
}: {
  goals: readonly SetupGoal[];
  hiddenIds?: readonly SetupGoalId[];
  onOpen: (id: SetupGoalId) => void;
  onHide: (id: SetupGoalId) => void;
}) {
  const t = useTheme();
  const counted = goals.filter((g) => g.done || !hiddenIds.includes(g.id));
  const done = counted.filter((g) => g.done).length;
  const shown = goals.filter((g) => !hiddenIds.includes(g.id));
  return (
    <View style={{ gap: t.space.sm }} testID="home-setup">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: t.space.sm }}>
          <Text variant="title3" accessibilityRole="header">
            {copy.title}
          </Text>
          <Text variant="subhead" tone="muted" accessibilityLabel={copy.progressSpoken(done, counted.length)} testID="home-setup-count">
            {copy.progress(done, counted.length)}
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
        {orderGoals(shown).map((g) => (
          <GoalTile key={g.id} goal={g} onPress={() => onOpen(g.id)} onHide={() => onHide(g.id)} />
        ))}
      </ScrollView>
    </View>
  );
}

/** Home's slot: renders nothing during a drive, until what it needs is read, once all is done, or once every tile is removed. */
export function HomeSetupGoals({ hidden }: { hidden: boolean }) {
  const router = useRouter();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  // null: not read yet (no flash of a tile removed earlier).
  const [hiddenIds, setHiddenIds] = useState<SetupGoalId[] | null>(null);
  useEffect(() => {
    let live = true;
    void settings
      .get<unknown>(SETUP_GOALS_HIDDEN_KEY)
      .then((v) => live && setHiddenIds(parseHiddenGoals(v)))
      .catch(() => live && setHiddenIds([]));
    return () => {
      live = false;
    };
  }, [settings]);
  const { contacts, refetch: refetchContacts } = useEmergencyContacts();
  const { places } = usePlaces();
  const client = useQueryClient();
  const car = useCarLink();
  const dashpal = useDashcamSelector(selectDashpalPaired);
  // Not read during a drive, when the row never shows.
  const friends = useFriends({ enabled: !hidden });
  // Something set up a screen deeper shows as done on the way back (the car link and friends read again on focus themselves).
  useFocusEffect(
    useCallback(() => {
      void refetchContacts();
      void client.invalidateQueries({ queryKey: PLACES_QUERY });
    }, [refetchContacts, client])
  );

  // Wait for every goal that can still be read, so a finished driver never sees the row flash in.
  const friendsLoading = friends.data === undefined && friends.status === 'pending' && friends.fetchStatus === 'fetching';
  if (hidden || hiddenIds === null || contacts === undefined || places === undefined) return null;
  if (car.view.status === 'loading' || dashpal === null || friendsLoading) return null;
  const goals: SetupGoal[] = [
    { id: 'emergency', done: contacts.length > 0 },
    { id: 'places', done: places.length > 0 },
    ...(car.view.status === 'ready' ? [{ id: 'car' as const, done: car.view.state.cars.length > 0 }] : []),
    { id: 'dashpal', done: dashpal },
    // Friends that could not be read (offline, an error, signed out) leave their tile out.
    ...(friends.data ? [{ id: 'friend' as const, done: friends.data.friends.length >= 1 }] : []),
  ];
  if (goals.every((g) => g.done) || goals.every((g) => hiddenIds.includes(g.id))) return null;
  return (
    <SetupGoalsView
      goals={goals}
      hiddenIds={hiddenIds}
      onOpen={(id) => router.push(HREFS[id])}
      onHide={(id) => {
        const next = parseHiddenGoals([...hiddenIds, id]);
        setHiddenIds(next);
        void settings.set(SETUP_GOALS_HIDDEN_KEY, next).catch(() => {});
      }}
    />
  );
}

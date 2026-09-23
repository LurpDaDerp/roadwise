import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useDataSource } from '@/data/queries';
import { TripTopBar } from '@/features/trips/TopBar';
import { deviceZone } from '@/lib/deviceZone';
import { dayKey } from '@/lib/time';
import { Banner, Card, EmptyState, Screen, Skeleton, Text, useTheme } from '@/ui';

import type { ChallengeDef, Enrolment, GoalCategory, RewardsApi, RewardsSnapshot } from '../api';
import { CATEGORY_LABEL, OFFLINE_LINE, pointsText } from '../copy/common';
import { challengeName, challengesCopy as copy } from '../copy/challenges';
import { currentWeekGoal } from '../goal/weeks';
import { challengeHref } from '../hub/routes';
import { useEnsureWeek } from '../useEnsureWeek';
import { useRewards } from '../useRewards';
import { challengeView } from '../viewModel';
import { ChallengeRow, formatInstant } from './ChallengeRow';

export type ChallengeTab = 'active' | 'discover' | 'done';
const TABS: readonly ChallengeTab[] = ['active', 'discover', 'done'];

/**
 * The defs to discover, in display order, with the one whose predicate is this week's goal
 * category first (§R6: "F2 recommends the challenge matching the current goal category first").
 * `suggested` is that def's id, or null when this week has no goal or nothing matches.
 */
export function discoverDefs(
  defs: readonly ChallengeDef[],
  goalCategory: GoalCategory | null
): { defs: ChallengeDef[]; suggested: string | null } {
  const sorted = defs.filter((d) => d.active).sort((a, b) => a.sort - b.sort);
  const match = goalCategory === null ? undefined : sorted.find((d) => d.predicate === goalCategory);
  if (!match) return { defs: sorted, suggested: null };
  return { defs: [match, ...sorted.filter((d) => d !== match)], suggested: match.id };
}

/** Running enrolments, and the finished ones (completed or ended — never left), newest first. */
export function challengeLists(snapshot: Pick<RewardsSnapshot, 'challenges'>): { active: Enrolment[]; done: Enrolment[] } {
  const finishedAt = (e: Enrolment) => e.completed_at ?? e.ended_at ?? e.updated_at;
  return {
    active: snapshot.challenges.filter((e) => e.state === 'active'),
    done: snapshot.challenges
      .filter((e) => e.state === 'completed' || e.state === 'ended')
      .sort((a, b) => Date.parse(finishedAt(b)) - Date.parse(finishedAt(a))),
  };
}

export const nameOf = (def: ChallengeDef): string => challengeName(def.id, def.predicate, CATEGORY_LABEL);
export const sentenceOf = (def: ChallengeDef): string => copy.sentence(def.predicate, def.target_days, def.window_days);

/** How a finished enrolment finished, in one line. */
export function finishedLine(e: Enrolment, def: ChallengeDef, tz: string): string {
  const v = challengeView(e, def);
  if (e.state === 'completed' && e.completed_at) return copy.completedOn(formatInstant(e.completed_at, tz));
  return copy.endedAfter(v.drivingDays, v.pass);
}

/**
 * The segmented control: three tabs over the list. A wrapping row, so at 200 % text the tabs
 * stack rather than crush; each is a `tab` in a `tablist`, so a screen reader hears which is open.
 */
function Tabs({ value, onChange }: { value: ChallengeTab; onChange: (t: ChallengeTab) => void }) {
  const th = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={copy.tabsLabel}
      testID="challenge-tabs"
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: th.space.xs,
        padding: th.space.xs,
        borderRadius: th.radius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: th.colors.borderStrong,
        backgroundColor: th.colors.surface,
      }}
    >
      {TABS.map((tab) => {
        const selected = tab === value;
        return (
          <Pressable
            key={tab}
            testID={`challenge-tab-${tab}`}
            accessibilityRole="tab"
            accessibilityLabel={copy.tabs[tab]}
            accessibilityState={{ selected }}
            onPress={() => onChange(tab)}
            style={({ pressed }) => ({
              flexGrow: 1,
              minHeight: 44,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: th.space.md,
              borderRadius: th.radius.sm,
              backgroundColor: selected ? th.colors.accent : pressed ? th.colors.surfaceRaised : 'transparent',
            })}
          >
            <Text variant="headline" style={{ color: selected ? th.colors.accentText : th.colors.text }}>
              {copy.tabs[tab]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * F2 · Challenges (D7): personal challenges counted in driving days. *Active* shows what is
 * running and how many days have counted; *Discover* the four, this week's goal's match first;
 * *Done* the completed and ended ones. No clock anywhere: a challenge counts the days you drive.
 *
 * No primary action on the list; joining happens on a challenge's own page.
 */
export function ChallengesScreen({ deps = {}, tz }: { deps?: { api?: RewardsApi }; tz?: string }) {
  const th = useTheme();
  const router = useRouter();
  const { now } = useDataSource();
  const rewards = useRewards(deps);
  useEnsureWeek(deps);
  const [chosen, setChosen] = useState<ChallengeTab | null>(null);

  const zone = tz ?? deviceZone();
  const today = dayKey(new Date(now()), zone);
  const data = rewards.data;
  const back = router.canGoBack() ? () => router.back() : null;

  let body;
  let tabs = null;
  if (data === undefined && rewards.isError) {
    body = (
      <Banner
        testID="challenges-error"
        tone="danger"
        message={copy.error.message}
        action={{ label: copy.error.retry, onPress: () => void rewards.refetch() }}
      />
    );
  } else if (data === undefined) {
    body = (
      <View accessible accessibilityRole="progressbar" accessibilityLabel={copy.loading} testID="challenges-loading">
        <Card padded={false}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ padding: th.space.lg, gap: th.space.sm }}>
              <Skeleton width="50%" height={18} />
              <Skeleton width="85%" height={14} />
            </View>
          ))}
        </Card>
      </View>
    );
  } else {
    const snap = data.snapshot;
    const defsById = new Map(snap.challengeDefs.map((d) => [d.id, d]));
    const lists = challengeLists(snap);
    const tab = chosen ?? (lists.active.length > 0 ? 'active' : 'discover');
    const goal = currentWeekGoal(snap, today);
    const open = (id: string) => router.push(challengeHref(id));
    tabs = <Tabs value={tab} onChange={setChosen} />;

    const rows: React.ReactNode[] = [];
    if (tab === 'active') {
      for (const e of lists.active) {
        const def = defsById.get(e.def_id);
        if (!def) continue;
        const v = challengeView(e, def);
        rows.push(
          <ChallengeRow
            key={e.id}
            name={nameOf(def)}
            sentence={sentenceOf(def)}
            line={copy.progress(v.pass, v.target, Math.max(0, v.window - v.drivingDays))}
            onPress={() => open(def.id)}
            testID={`challenge-row-${def.id}`}
          />
        );
      }
    } else if (tab === 'discover') {
      const running = new Set(lists.active.map((e) => e.def_id));
      const { defs, suggested } = discoverDefs(snap.challengeDefs, goal?.category ?? null);
      for (const def of defs) {
        rows.push(
          <ChallengeRow
            key={def.id}
            name={nameOf(def)}
            sentence={sentenceOf(def)}
            line={pointsText(def.points)}
            stamp={running.has(def.id) ? copy.running : def.id === suggested ? copy.suggested : undefined}
            onPress={() => open(def.id)}
            testID={`challenge-row-${def.id}`}
          />
        );
      }
    } else {
      for (const e of lists.done) {
        const def = defsById.get(e.def_id);
        if (!def) continue;
        rows.push(
          <ChallengeRow
            key={e.id}
            name={nameOf(def)}
            sentence={sentenceOf(def)}
            line={finishedLine(e, def, zone)}
            stamp={e.state === 'completed' ? copy.completed : copy.ended}
            onPress={() => open(e.id)}
            testID={`challenge-row-${def.id}`}
          />
        );
      }
    }

    const empty = tab === 'active' ? copy.empty.active : tab === 'done' ? copy.empty.done : null;
    body =
      rows.length === 0 && empty ? (
        <EmptyState
          testID={`challenges-empty-${tab}`}
          title={empty.title}
          body={empty.body}
          action={{ label: empty.action, onPress: () => setChosen('discover') }}
        />
      ) : (
        <Card padded={false} testID={`challenges-list-${tab}`}>
          {rows.map((row, i) => (
            <View
              key={i}
              style={{ borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: th.colors.divider }}
            >
              {row}
            </View>
          ))}
        </Card>
      );
  }

  return (
    <Screen scroll testID="challenges-screen">
      <TripTopBar title={copy.title} onBack={back} />
      {data?.offline ? <Banner testID="challenges-offline" tone="info" message={OFFLINE_LINE} /> : null}
      {tabs}
      {body}
    </Screen>
  );
}

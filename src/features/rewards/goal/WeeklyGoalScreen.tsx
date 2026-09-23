import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useDataSource } from '@/data/queries';
import { Field, FieldText } from '@/features/insights/Field';
import { TripTopBar } from '@/features/trips/TopBar';
import { deviceZone } from '@/lib/deviceZone';
import { dayKey } from '@/lib/time';
import { Banner, Button, Card, EmptyState, Screen, Skeleton, Text, useTheme } from '@/ui';

import type { RewardsApi, RewardsSnapshot, WeeklyGoal } from '../api';
import { DayBar, shiftDay } from '../challenges/ChallengeRow';
import { goalActiveLine, goalSentence, OFFLINE_LINE } from '../copy/common';
import { goalCopy as copy } from '../copy/goal';
import { useEnsureWeek } from '../useEnsureWeek';
import { useRewards } from '../useRewards';
import { goalView, isoWeekStart } from '../viewModel';
import { FocusPicker } from './FocusPicker';

/** F2's weekly goal (the notifications' `goal_completed` link). Typed routes are generated at `expo start`. */
export const GOAL_HREF = '/rewards/goal' as Href;

/**
 * This week's goal and last week's, by ISO week. The snapshot's newest goal is this week's only
 * when its `week_start` is this week's Monday (T7 concern 4): offline, before `open_my_week` has
 * run, it is still last week's and must not be shown as this week's.
 */
export function goalWeeks(
  snapshot: Pick<RewardsSnapshot, 'currentGoal' | 'lastGoal'>,
  today: string
): { thisWeek: WeeklyGoal | null; lastWeek: WeeklyGoal | null } {
  const week = isoWeekStart(today);
  const previous = shiftDay(week, -7);
  const goals = [snapshot.currentGoal, snapshot.lastGoal].filter((g): g is WeeklyGoal => g !== null);
  return {
    thisWeek: goals.find((g) => g.week_start === week) ?? null,
    lastWeek: goals.find((g) => g.week_start === previous) ?? null,
  };
}

function lastWeekLine(goal: WeeklyGoal): string {
  const sentence = goalSentence(goal.category, goal.target_days);
  switch (goal.state) {
    case 'achieved':
      return goal.prorated ? copy.lastWeek.achievedProrated(sentence) : copy.lastWeek.achieved(sentence);
    case 'ended':
      return copy.lastWeek.ended(sentence);
    case 'no_drives':
      return copy.lastWeek.noDrives;
    case 'active':
      return copy.lastWeek.confirming;
  }
}

/**
 * F2 · the weekly goal (D6). The focus printed as a sentence, how many driving days have counted
 * (text and a bar that speaks), the shared active line (the proration rule only while it can
 * still hold), that today counts only once it closes, and last week's result. Everything is the server's settled value; nothing is counted before it settles.
 *
 * No primary action: the screen is a record to read. "Change focus" opens the picker, whose Save
 * is the one action inside its sheet.
 */
export function WeeklyGoalScreen({ deps = {}, tz }: { deps?: { api?: RewardsApi }; tz?: string }) {
  const th = useTheme();
  const router = useRouter();
  const { now } = useDataSource();
  const rewards = useRewards(deps);
  useEnsureWeek(deps);
  const [picking, setPicking] = useState(false);

  const today = dayKey(new Date(now()), tz ?? deviceZone());
  const data = rewards.data;
  const weeks = data ? goalWeeks(data.snapshot, today) : null;
  const back = router.canGoBack() ? () => router.back() : null;

  let body;
  if (data === undefined && rewards.isError) {
    body = (
      <Banner
        testID="goal-error"
        tone="danger"
        message={copy.error.message}
        action={{ label: copy.error.retry, onPress: () => void rewards.refetch() }}
      />
    );
  } else if (weeks === null) {
    body = (
      <View accessible accessibilityRole="progressbar" accessibilityLabel={copy.loading} testID="goal-loading">
        <Card variant="license">
          <Skeleton width="40%" height={14} />
          <Skeleton width="90%" height={28} />
          <Skeleton width="100%" height={40} />
        </Card>
      </View>
    );
  } else {
    body = (
      <>
        {weeks.thisWeek ? (
          <ThisWeek goal={weeks.thisWeek} />
        ) : (
          <EmptyState
            testID="goal-none"
            title={copy.noGoal.title}
            body={copy.noGoal.body}
            action={{ label: copy.error.retry, onPress: () => void rewards.refetch() }}
          />
        )}
        {weeks.lastWeek ? (
          <Card testID="goal-last-week">
            <Field label={copy.lastWeekLabel}>
              <Text variant="body">{lastWeekLine(weeks.lastWeek)}</Text>
            </Field>
          </Card>
        ) : null}
      </>
    );
  }

  return (
    <Screen scroll testID="goal-screen">
      <TripTopBar title={copy.title} onBack={back} />
      {data?.offline ? <Banner testID="goal-offline" tone="info" message={OFFLINE_LINE} /> : null}
      {body}
      {data !== undefined ? (
        <View style={{ marginTop: 'auto', paddingTop: th.space.md }}>
          <Button
            label={copy.changeFocus}
            variant="secondary"
            onPress={() => setPicking(true)}
            accessibilityHint={copy.changeFocusHint}
            testID="goal-change-focus"
          />
        </View>
      ) : null}
      <FocusPicker
        visible={picking}
        current={weeks?.thisWeek?.category ?? null}
        target={weeks?.thisWeek?.target_days ?? 4}
        currentCounted={(weeks?.thisWeek?.pass_days ?? 0) + (weeks?.thisWeek?.fail_days ?? 0) > 0}
        deps={deps}
        onClose={() => setPicking(false)}
      />
    </Screen>
  );
}

function ThisWeek({ goal }: { goal: WeeklyGoal }) {
  const view = goalView(goal);
  const active = view.state === 'active';
  const line = active
    ? goalActiveLine({ pass: view.pass, target: view.target, failDays: view.fail, withCount: false })
    : view.remainingText;
  return (
    <Card variant="license" testID="goal-this-week">
      <Field label={copy.focusLabel}>
        <FieldText variant="title2">{goalSentence(view.category, view.target)}</FieldText>
      </Field>
      <Field label={copy.progressLabel}>
        <DayBar
          value={view.pass}
          max={view.target}
          text={copy.progress(view.pass, view.target)}
          spoken={copy.progressSpoken(view.pass, view.target)}
          label={copy.progressLabel}
          testID="goal-progress"
        />
        {/* The shared line, without its count: the bar above already prints "2 of 4 driving days".
            Active, it is the proration promise only while no day has failed (0009 achieves a short
            week only with fail_days = 0) and nothing after a failed day (null); a closed state's line
            is the shared `GOAL_PROGRESS` one. */}
        {line !== null ? (
          <Text variant="subhead" testID="goal-line">
            {line}
          </Text>
        ) : null}
        {active ? (
          <Text variant="footnote" tone="muted">
            {copy.today}
          </Text>
        ) : null}
      </Field>
      {view.state === 'active' || view.state === 'achieved' ? (
        <Field label={copy.pointsLabel}>
          <Text variant="body">
            {view.state === 'achieved' ? copy.pointsAdded(view.points) : copy.pointsWhenReached(view.points)}
          </Text>
        </Field>
      ) : null}
    </Card>
  );
}

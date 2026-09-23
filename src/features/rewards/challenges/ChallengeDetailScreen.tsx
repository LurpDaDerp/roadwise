import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { useDataSource } from '@/data/queries';
import { useOnline } from '@/data/net/useOnline';
import { Field, FieldText } from '@/features/insights/Field';
import { TripTopBar } from '@/features/trips/TopBar';
import { deviceZone } from '@/lib/deviceZone';
import { dayKey } from '@/lib/time';
import { Banner, Button, Card, EmptyState, Screen, Skeleton, Text, useTheme } from '@/ui';
import { REWARDS } from '@scoring';

import { RewardsRpcError, type ChallengeDef, type Enrolment, type EnrolmentSummary, type RewardsApi } from '../api';
import { OFFLINE_LINE } from '../copy/common';
import { challengesCopy as copy } from '../copy/challenges';
import { useJoinChallenge, useLeaveChallenge, useRewards } from '../useRewards';
import { challengeView } from '../viewModel';
import { DayBar, formatDay, formatInstant } from './ChallengeRow';
import { nameOf, sentenceOf } from './ChallengesScreen';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Shown = Pick<Enrolment, 'id' | 'def_id' | 'start_day' | 'state' | 'pass_days' | 'fail_days'> &
  Partial<Pick<Enrolment, 'completed_at' | 'ended_at'>>;

const codeOf = (e: unknown) => (e instanceof RewardsRpcError ? e.code : 'unknown');

/**
 * F2 · one challenge. Opened by a def id (from Active or Discover: its running enrolment, or the
 * offer to join) or by an enrolment id (from Done: that finished run).
 *
 * States: not joined (rules, fairness, points, *Join*); running (progress in driving days, *Leave*
 * after a confirm); completed (the date and the points added); ended (said plainly); offline (Join
 * disabled, with the offline line). *Join* is disabled while two are running (§R6). Every count is
 * the server's settled one: a day counts once it is confirmed, and then it is final (rev1: R-A).
 */
export function ChallengeDetailScreen({
  challengeId,
  deps = {},
  tz,
}: {
  challengeId: string;
  deps?: { api?: RewardsApi };
  tz?: string;
}) {
  const th = useTheme();
  const router = useRouter();
  const { now } = useDataSource();
  const online = useOnline();
  const rewards = useRewards(deps);
  const join = useJoinChallenge(deps);
  const leave = useLeaveChallenge(deps);
  const [joined, setJoined] = useState<EnrolmentSummary | null>(null);
  const [leftId, setLeftId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const zone = tz ?? deviceZone();
  const today = dayKey(new Date(now()), zone);
  const data = rewards.data;
  const back = router.canGoBack() ? () => router.back() : null;

  const shell = (title: string, children: React.ReactNode, action?: React.ReactNode) => (
    <Screen scroll testID="challenge-screen">
      <TripTopBar title={title} onBack={back} />
      {data?.offline ? <Banner testID="challenge-offline" tone="info" message={OFFLINE_LINE} /> : null}
      {children}
      {action ? <View style={{ marginTop: 'auto', paddingTop: th.space.md, gap: th.space.sm }}>{action}</View> : null}
    </Screen>
  );

  if (data === undefined) {
    return shell(
      copy.title,
      rewards.isError ? (
        <Banner
          testID="challenge-error"
          tone="danger"
          message={copy.error.message}
          action={{ label: copy.error.retry, onPress: () => void rewards.refetch() }}
        />
      ) : (
        <View accessible accessibilityRole="progressbar" accessibilityLabel={copy.loading} testID="challenge-loading">
          <Card variant="license">
            <Skeleton width="80%" height={28} />
            <Skeleton width="100%" height={40} />
            <Skeleton width="100%" height={60} />
          </Card>
        </View>
      )
    );
  }

  const snap = data.snapshot;
  // Running, as the server last said, less one just left and plus one just joined.
  const running: Shown[] = snap.challenges.filter((e) => e.state === 'active' && e.id !== leftId);
  if (joined && joined.id !== leftId && !running.some((e) => e.id === joined.id)) running.push(joined);

  let def: ChallengeDef | undefined;
  let shown: Shown | undefined;
  if (UUID.test(challengeId)) {
    const e = snap.challenges.find((c) => c.id === challengeId);
    def = e ? snap.challengeDefs.find((d) => d.id === e.def_id) : undefined;
    shown = e && e.id === leftId ? { ...e, state: 'left' } : e;
  } else {
    def = snap.challengeDefs.find((d) => d.id === challengeId);
    shown = running.find((e) => e.def_id === challengeId);
  }

  if (!def) {
    return shell(copy.title, <EmptyState testID="challenge-missing" title={copy.notFound} body={copy.error.message} />);
  }
  const theDef = def;

  const runningThis = running.find((e) => e.def_id === theDef.id);
  const isRunning = shown?.state === 'active';
  const twoRunning = running.length >= REWARDS.MAX_ACTIVE_CHALLENGES;

  const doJoin = () => {
    setError(null);
    join.mutateAsync(theDef.id).then(
      (e) => {
        setJoined(e);
        setLeftId(null);
      },
      (e: unknown) => setError(copy.joinErrors[codeOf(e)])
    );
  };
  const doLeave = (id: string) => {
    setError(null);
    leave.mutateAsync(id).then(
      () => setLeftId(id),
      (e: unknown) => setError(copy.leaveErrors[codeOf(e)])
    );
  };
  const confirmLeave = (id: string) =>
    Alert.alert(copy.leaveConfirm.title, copy.leaveConfirm.body, [
      { text: copy.leaveConfirm.stay, style: 'cancel' },
      { text: copy.leaveConfirm.leave, style: 'destructive', onPress: () => doLeave(id) },
    ]);

  // --- the state block ------------------------------------------------------------------------
  let state: React.ReactNode = null;
  if (shown && isRunning) {
    const v = challengeView({ ...shown, state: 'active' }, theDef);
    const remaining = Math.max(0, v.window - v.drivingDays);
    state = (
      <Field label={copy.progressLabel}>
        <DayBar
          value={v.pass}
          max={v.target}
          text={copy.progress(v.pass, v.target, remaining)}
          spoken={copy.progressSpoken(v.pass, v.target, remaining)}
          label={copy.progressLabel}
          testID="challenge-progress"
        />
        {shown.start_day > today ? (
          <Text variant="footnote" tone="muted">
            {copy.startsTomorrow}
          </Text>
        ) : null}
      </Field>
    );
  } else if (shown?.state === 'completed' && shown.completed_at) {
    state = <Text variant="body">{copy.completedOn(formatInstant(shown.completed_at, zone))}</Text>;
  } else if (shown?.state === 'ended') {
    const v = challengeView({ ...shown, state: 'ended' }, theDef);
    state = <Text variant="body">{copy.endedAfter(v.drivingDays, v.pass)}</Text>;
  }

  const showLeft = shown?.state === 'left' || (leftId !== null && !isRunning);

  // --- the one action -------------------------------------------------------------------------
  let action: React.ReactNode;
  if (isRunning && shown) {
    const id = shown.id;
    action = (
      <>
        <Button
          label={copy.leave}
          variant="secondary"
          onPress={() => confirmLeave(id)}
          disabled={!online}
          loading={leave.isPending}
          accessibilityHint={!online ? copy.leaveOffline : undefined}
          testID="challenge-leave"
        />
        {!online ? (
          <Text variant="footnote" tone="muted" style={{ textAlign: 'center' }}>
            {copy.leaveOffline}
          </Text>
        ) : null}
      </>
    );
  } else if (runningThis) {
    // A past run of a challenge that is running again: its page is the running one.
    action = null;
  } else if (theDef.active) {
    const reason = !online ? copy.joinOffline : twoRunning ? copy.twoActive : null;
    action = (
      <>
        <Button
          label={shown || showLeft ? copy.joinAgain : copy.join}
          onPress={doJoin}
          disabled={reason !== null}
          loading={join.isPending}
          // A dimmed button says why to a screen reader too, not only in the footnote beside it.
          accessibilityHint={reason ?? undefined}
          testID="challenge-join"
        />
        {reason !== null ? (
          <Text variant="footnote" tone="muted" style={{ textAlign: 'center' }} testID="challenge-join-reason">
            {reason}
          </Text>
        ) : null}
      </>
    );
  } else {
    // A retired def (`active = false`) can't be joined: say so rather than show nothing.
    action = (
      <Text variant="footnote" tone="muted" style={{ textAlign: 'center' }} testID="challenge-unavailable">
        {copy.joinErrors.invalid}
      </Text>
    );
  }

  const points =
    shown?.state === 'completed' ? copy.pointsAdded(theDef.points) : copy.pointsOnComplete(theDef.points);

  return shell(
    nameOf(theDef),
    <>
      <Card variant="license" testID="challenge-card">
        <FieldText variant="title2">{sentenceOf(theDef)}</FieldText>
        {state}
        <Field label={copy.rulesLabel}>
          <Text variant="subhead">
            {isRunning && shown ? copy.rulesFrom(formatDay(shown.start_day)) : copy.rules}
          </Text>
          <Text variant="subhead" tone="muted">
            {copy.fairness}
          </Text>
        </Field>
        <Field label={copy.pointsLabel}>
          <Text variant="body">{points}</Text>
        </Field>
      </Card>
      {joined && isRunning && shown?.id === joined.id ? (
        <Banner tone="success" message={copy.joined} testID="challenge-joined" />
      ) : null}
      {showLeft ? <Banner tone="info" message={copy.leftNote} testID="challenge-left" /> : null}
      {error !== null ? <Banner tone="warning" message={error} testID="challenge-action-error" /> : null}
    </>,
    action
  );
}

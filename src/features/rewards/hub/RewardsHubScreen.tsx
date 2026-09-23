import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useDataSource } from '@/data/queries';
import { useOnline } from '@/data/net/useOnline';
import { deviceZone } from '@/lib/deviceZone';
import { dayKey } from '@/lib/time';
import { Banner, Button, Card, ListRow, Screen, Skeleton, Text, useTheme } from '@/ui';

import { RewardsOfflineError, type RewardsSnapshot, type WeeklyGoal } from '../api';
import { goalActiveLine, goalSentence, OFFLINE_LINE } from '../copy/common';
import { hubCopy as copy } from '../copy/hub';
import { useEnsureWeek } from '../useEnsureWeek';
import { useRewards, type RewardsDeps } from '../useRewards';
import { classView, goalView, isoWeekStart, streakView } from '../viewModel';
import { ActiveChallenges } from './ActiveChallenges';
import { ClassField } from './ClassField';
import { HowRewardsWork } from './HowRewardsWork';
import { NextBadge } from './NextBadge';
import { PointsField } from './PointsField';
import { badgeHref, BADGES_HREF, challengeHref, CHALLENGES_HREF, GOAL_HREF, INVITE_HREF } from './routes';
import { StreakField } from './StreakField';
import { TodayLine } from './TodayLine';
import { useReferralFlag } from './useReferralFlag';

/**
 * This week's goal, or null: the newest goal row counts only when its week is the current ISO week
 * in the phone's zone (T7 concern 4) — offline, before the week is opened, it can be last week's.
 */
export function thisWeeksGoal(snapshot: RewardsSnapshot, today: string): WeeklyGoal | null {
  const goal = snapshot.currentGoal;
  return goal !== null && goal.week_start === isoWeekStart(today) ? goal : null;
}

/** A new user: no settled progress yet (the server writes the row on the first settlement or week). */
export const isNewUser = (snapshot: RewardsSnapshot) => snapshot.progress === null || snapshot.progress.xp === 0;

function GoalRow({ goal, offline, onOpen }: { goal: WeeklyGoal | null; offline: boolean; onOpen: () => void }) {
  const th = useTheme();
  let subtitle: string;
  let detail: string | null = null;
  let spoken: string;
  if (goal === null) {
    subtitle = offline ? copy.goal.offline : copy.goal.opening;
    spoken = `${copy.goal.title}, ${subtitle}`;
  } else {
    const view = goalView(goal);
    subtitle = goalSentence(goal.category, goal.target_days);
    // The shared active line (T7 round 1): its count, and the proration promise only while it holds.
    detail =
      view.state === 'active'
        ? goalActiveLine({ pass: view.pass, target: view.target, failDays: view.fail })
        : view.remainingText;
    spoken = [copy.goal.title, subtitle, detail].join(', ');
  }
  return (
    <ListRow
      testID="hub-goal"
      title={copy.goal.title}
      subtitle={subtitle}
      detail={
        detail ? (
          <Text variant="footnote" tone="muted" testID="hub-goal-progress">
            {detail}
          </Text>
        ) : undefined
      }
      leading={<Ionicons name="flag-outline" size={22} color={th.colors.accent} />}
      onPress={onOpen}
      accessibilityLabel={spoken}
    />
  );
}

function HubSkeleton() {
  const th = useTheme();
  return (
    <View style={{ gap: th.space.lg }} testID="hub-loading">
      <Card variant="license">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.lg }}>
          <Skeleton width={120} height={46} />
          <Skeleton width={160} height={46} />
          <Skeleton width={80} height={46} />
        </View>
      </Card>
      <Card>
        <Skeleton width="60%" height={18} />
        <Skeleton width="85%" height={14} />
      </Card>
    </View>
  );
}

/** The licence-style card: POINTS, CLASS and STREAK, printed from the settled progress only. */
export function HubCard({ snapshot }: { snapshot: RewardsSnapshot }) {
  const th = useTheme();
  const cls = classView(snapshot.progress);
  const streak = streakView(snapshot.progress);
  return (
    <Card variant="license" testID="hub-card">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.lg }} testID="hub-card-fields">
        <PointsField points={snapshot.progress?.points ?? 0} />
        <ClassField view={cls} />
        <StreakField view={streak} />
      </View>
    </Card>
  );
}

/**
 * F1 · Rewards (the tab): the licence-style card (POINTS, CLASS, STREAK), today's line, this
 * week's goal, up to two active challenges, the next badge, the links, and how it all works.
 *
 * - Every value is the server's settled one; today is only ever "so far", confirmed when the day
 *   closes. Points are never money (the explainer says so in words).
 * - One primary action, "Find a challenge", only while none is active.
 * - No store, leaderboard or crew link or teaser: none is built, so none is promised.
 * - Fetches when the tab mounts with stale data (`useRewards`); nothing polls.
 */
export function RewardsHubScreen({ deps = {}, tz }: { deps?: RewardsDeps; tz?: string }) {
  const th = useTheme();
  const router = useRouter();
  const { now } = useDataSource();
  const online = useOnline();
  const rewards = useRewards(deps);
  useEnsureWeek(deps);
  const referralOn = useReferralFlag();
  const zone = tz ?? deviceZone();
  const today = dayKey(new Date(now()), zone);
  const data = rewards.data;

  const retry = () => void rewards.refetch();

  let body;
  let hasActive = true;
  if (data === undefined && rewards.isError) {
    const offline = rewards.error instanceof RewardsOfflineError;
    body = (
      <Banner
        testID="hub-error"
        tone={offline ? 'info' : 'danger'}
        message={offline ? copy.offlineEmpty : copy.error}
        action={{ label: copy.retry, onPress: retry }}
      />
    );
  } else if (data === undefined) {
    body = <HubSkeleton />;
  } else {
    const { snapshot } = data;
    const goal = thisWeeksGoal(snapshot, today);
    hasActive = snapshot.challenges.some((c) => c.state === 'active');
    const earnedIds = new Set(snapshot.badges.map((b) => b.badge_id));
    const teaserDefs = snapshot.badgeDefs.filter((d) => d.family !== 'referrals' || referralOn || earnedIds.has(d.id));
    const links = [
      { key: 'badges', label: copy.links.badges, icon: 'ribbon-outline' as const, href: BADGES_HREF },
      { key: 'challenges', label: copy.links.challenges, icon: 'trail-sign-outline' as const, href: CHALLENGES_HREF },
      ...(referralOn
        ? [{ key: 'invite', label: copy.links.invite, icon: 'person-add-outline' as const, href: INVITE_HREF }]
        : []),
    ];
    body = (
      <>
        <HubCard snapshot={snapshot} />
        {isNewUser(snapshot) ? (
          <Text variant="subhead" testID="hub-new-user">
            {copy.newUser}
          </Text>
        ) : null}
        <TodayLine tz={zone} progress={snapshot.progress} settledDays={snapshot.days} />
        <Card padded={false}>
          <GoalRow goal={goal} offline={data.offline || !online} onOpen={() => router.push(GOAL_HREF)} />
        </Card>
        <ActiveChallenges
          enrolments={snapshot.challenges}
          defs={snapshot.challengeDefs}
          onOpen={(defId) => router.push(challengeHref(defId))}
        />
        <NextBadge
          progress={snapshot.progress}
          defs={teaserDefs}
          earned={snapshot.badges}
          onOpen={(id) => router.push(badgeHref(id))}
        />
        <Card padded={false} testID="hub-links">
          {links.map((l, i) => (
            <View
              key={l.key}
              style={{ borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: th.colors.divider }}
            >
              <ListRow
                testID={`hub-link-${l.key}`}
                title={l.label}
                leading={<Ionicons name={l.icon} size={22} color={th.colors.accent} />}
                onPress={() => router.push(l.href)}
              />
            </View>
          ))}
        </Card>
        <HowRewardsWork />
      </>
    );
  }

  return (
    <Screen bottomInset={false} padded={false} testID="hub-screen">
      <View style={{ flex: 1 }}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: th.space.lg, gap: th.space.lg }}
          showsVerticalScrollIndicator={false}
          testID="hub"
        >
          <Text variant="title1" accessibilityRole="header">
            {copy.title}
          </Text>
          {data?.offline ? <Banner testID="hub-offline" tone="info" message={OFFLINE_LINE} /> : null}
          {data !== undefined && rewards.isError ? (
            <Banner testID="hub-error" tone="danger" message={copy.error} action={{ label: copy.retry, onPress: retry }} />
          ) : null}
          {body}
        </ScrollView>
        {hasActive ? null : (
          <View
            style={{
              paddingHorizontal: th.space.lg,
              paddingVertical: th.space.md,
              borderTopWidth: 1,
              borderTopColor: th.colors.divider,
              backgroundColor: th.colors.bg,
            }}
          >
            <Button testID="hub-find-challenge" label={copy.findChallenge} onPress={() => router.push(CHALLENGES_HREF)} />
          </View>
        )}
      </View>
    </Screen>
  );
}

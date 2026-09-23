import { useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { useDataSource } from '@/data/queries';
import { useSession } from '@/data/supabase/session';
import { TripTopBar } from '@/features/trips/TopBar';
import { deviceZone } from '@/lib/deviceZone';
import { Banner, Button, Card, EmptyState, Screen, Skeleton, Text, useTheme } from '@/ui';

import { RewardsOfflineError } from '../api';
import { BADGE_COPY, badgesCopy as copy } from '../copy/badges';
import { BADGE_TIER_LABEL, OFFLINE_LINE } from '../copy/common';
import { shareBadgeHref } from '../hub/routes';
import { ProgressBar } from '../ui/ProgressBar';
import { Seal } from '../ui/Seal';
import { useRewards, type RewardsDeps } from '../useRewards';
import { badgeCurrent } from '../viewModel';
import { FAMILY_GLYPH, formatEarnedDate, isKnownBadge } from './BadgeSeal';
import { useFreshBadges } from './seen';

/**
 * F3 · One badge: the seal, its criterion, and either the day it was earned or the progress so far.
 * The one primary action, *Share*, exists only for an earned badge and opens the F9 composer.
 */
export function BadgeDetailScreen({ badgeId, deps = {}, tz }: { badgeId: string; deps?: RewardsDeps; tz?: string }) {
  const th = useTheme();
  const router = useRouter();
  const { now } = useDataSource();
  const uid = useSession().session?.user.id ?? null;
  const rewards = useRewards(deps);
  const data = rewards.data;
  const known = isKnownBadge(badgeId);
  const def = known ? data?.snapshot.badgeDefs.find((d) => d.id === badgeId) : undefined;
  const earned = data?.snapshot.badges.find((b) => b.badge_id === badgeId);
  const fresh = useFreshBadges(uid, data ? (earned ? [badgeId] : []) : undefined);
  const back = router.canGoBack() ? () => router.back() : null;

  let body;
  let share = null;
  if (data === undefined && rewards.isError) {
    const offline = rewards.error instanceof RewardsOfflineError;
    body = (
      <Banner
        testID="badge-error"
        tone={offline ? 'info' : 'danger'}
        message={offline ? copy.offlineEmpty : copy.error}
        action={{ label: copy.retry, onPress: () => void rewards.refetch() }}
      />
    );
  } else if (data === undefined || fresh === null) {
    body = (
      <Card testID="badge-loading">
        <View style={{ alignItems: 'center', gap: th.space.md }}>
          <Skeleton width={128} height={128} radius={64} />
          <Skeleton width="50%" height={22} />
          <Skeleton width="80%" height={16} />
        </View>
      </Card>
    );
  } else if (!known || def === undefined) {
    body = (
      <EmptyState
        testID="badge-unknown"
        title={copy.title}
        body={copy.unknown}
        action={back ? { label: copy.back, onPress: back } : undefined}
      />
    );
  } else {
    const words = BADGE_COPY[badgeId as keyof typeof BADGE_COPY];
    const tier = BADGE_TIER_LABEL[def.tier];
    const current = badgeCurrent(data.snapshot.progress, def.metric);
    const criterion = words.criterion(def.threshold);
    const date = earned ? formatEarnedDate(earned.earned_at, tz ?? deviceZone(), now()) : null;
    const progressText = copy.progress(Math.min(current, def.threshold), def.threshold, def.metric);
    body = (
      <Card variant="license" testID="badge-detail">
        <View style={{ alignItems: 'center', gap: th.space.md }}>
          <Seal
            size="lg"
            tier={def.tier}
            earned={earned !== undefined}
            glyph={FAMILY_GLYPH[def.family]}
            label={
              date ? copy.seal.earned(words.name, tier, date.spoken) : copy.seal.locked(words.name, tier)
            }
            animate={fresh.has(badgeId)}
            testID="badge-seal"
          />
          <Text variant="title2" accessibilityRole="header" style={{ textAlign: 'center' }}>
            {words.name}
          </Text>
          <Text variant="body" style={{ textAlign: 'center' }} testID="badge-criterion">
            {criterion}
          </Text>
          {date ? (
            <Text variant="subhead" tone="muted" accessibilityLabel={copy.earned(date.spoken)} testID="badge-earned">
              {copy.earned(date.printed)}
            </Text>
          ) : (
            <View style={{ alignSelf: 'stretch', gap: th.space.sm }}>
              <ProgressBar fraction={current / def.threshold} />
              <Text variant="subhead" tone="muted" style={{ textAlign: 'center' }} testID="badge-progress">
                {progressText}
              </Text>
            </View>
          )}
        </View>
      </Card>
    );
    if (earned) {
      share = (
        <Button
          testID="badge-share"
          label={copy.share}
          accessibilityHint={copy.shareHint}
          onPress={() => router.push(shareBadgeHref(badgeId))}
        />
      );
    }
  }

  return (
    <Screen testID="badge-detail-screen">
      <TripTopBar title={copy.title} onBack={back} />
      {/* The record scrolls (200 % type); Share stays anchored under it. */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: th.space.lg }} showsVerticalScrollIndicator={false}>
        {data?.offline ? <Banner testID="badge-offline" tone="info" message={OFFLINE_LINE} /> : null}
        {body}
      </ScrollView>
      {share}
    </Screen>
  );
}

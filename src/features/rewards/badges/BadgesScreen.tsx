import type { BadgeId } from '@scoring';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { useDataSource } from '@/data/queries';
import { useSession } from '@/data/supabase/session';
import { TripTopBar } from '@/features/trips/TopBar';
import { deviceZone } from '@/lib/deviceZone';
import { Banner, Card, Screen, Skeleton, Text, useTheme } from '@/ui';

import { RewardsOfflineError, type BadgeDef, type BadgeMetric, type EarnedBadge, type RewardsSnapshot } from '../api';
import { badgesCopy as copy, FAMILY_TITLE } from '../copy/badges';
import { OFFLINE_LINE } from '../copy/common';
import { badgeHref } from '../hub/routes';
import { useReferralFlag } from '../hub/useReferralFlag';
import { useRewards, type RewardsDeps } from '../useRewards';
import { badgeCurrent } from '../viewModel';
import { BadgeSeal, isKnownBadge } from './BadgeSeal';
import { useFreshBadges } from './seen';

export type KnownBadgeDef = BadgeDef & { id: BadgeId };

export interface BadgeFamily {
  family: BadgeMetric;
  defs: KnownBadgeDef[];
}

/**
 * The defs the grid shows, grouped by family in display order. The referral badge is shown only
 * while inviting is available, or once it has been earned: a locked badge for a feature the driver
 * cannot use would promise something that isn't there.
 */
export function badgeFamilies(snapshot: RewardsSnapshot, referralOn: boolean): BadgeFamily[] {
  const earned = new Set(snapshot.badges.map((b) => b.badge_id));
  const defs = [...snapshot.badgeDefs]
    .filter((d): d is KnownBadgeDef => isKnownBadge(d.id))
    .filter((d) => d.family !== 'referrals' || referralOn || earned.has(d.id))
    .sort((a, b) => a.sort - b.sort);
  const families: BadgeFamily[] = [];
  for (const def of defs) {
    const group = families.find((f) => f.family === def.family);
    if (group) group.defs.push(def);
    else families.push({ family: def.family, defs: [def] });
  }
  return families;
}

/** The threshold of the first safe-days badge, for the empty line (7 today). */
function firstSafeThreshold(defs: readonly BadgeDef[]): number {
  const safe = defs.filter((d) => d.metric === 'safe_days').sort((a, b) => a.threshold - b.threshold);
  return safe[0]?.threshold ?? 7;
}

/**
 * F3 · Badges: every badge, grouped by family. Earned seals carry their date; locked ones their
 * criterion and the progress so far, so the way to each is always visible (§R7). A seal thumps once,
 * the first time this phone shows it. No primary action: the collection is a record.
 */
export function BadgesScreen({ deps = {}, tz }: { deps?: RewardsDeps; tz?: string }) {
  const th = useTheme();
  const router = useRouter();
  const { now } = useDataSource();
  const uid = useSession().session?.user.id ?? null;
  const rewards = useRewards(deps);
  const referralOn = useReferralFlag();
  const data = rewards.data;
  const fresh = useFreshBadges(uid, data?.snapshot.badges.map((b) => b.badge_id));
  const zone = tz ?? deviceZone();
  const back = router.canGoBack() ? () => router.back() : null;

  let body;
  if (data === undefined && rewards.isError) {
    const offline = rewards.error instanceof RewardsOfflineError;
    body = (
      <Banner
        testID="badges-error"
        tone={offline ? 'info' : 'danger'}
        message={offline ? copy.offlineEmpty : copy.error}
        action={{ label: copy.retry, onPress: () => void rewards.refetch() }}
      />
    );
  } else if (data === undefined || fresh === null) {
    body = (
      <Card testID="badges-loading">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.lg }}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ alignItems: 'center', gap: th.space.sm, flexGrow: 1, flexBasis: 140 }}>
              <Skeleton width={72} height={72} radius={36} />
              <Skeleton width="70%" height={14} />
            </View>
          ))}
        </View>
      </Card>
    );
  } else {
    const { snapshot } = data;
    const byId = new Map<string, EarnedBadge>(snapshot.badges.map((b) => [b.badge_id, b]));
    const families = badgeFamilies(snapshot, referralOn);
    const total = families.reduce((sum, f) => sum + f.defs.length, 0);
    const earnedCount = families.reduce((sum, f) => sum + f.defs.filter((d) => byId.has(d.id)).length, 0);
    body = (
      <View style={{ gap: th.space.xl }} testID="badges-grid">
        <Text variant="subhead" tone="muted" testID="badges-summary">
          {earnedCount === 0 ? copy.empty(firstSafeThreshold(snapshot.badgeDefs)) : copy.countEarned(earnedCount, total)}
        </Text>
        {families.map((f) => (
          <View key={f.family} style={{ gap: th.space.sm }} testID={`badge-family-${f.family}`}>
            <Text variant="headline" accessibilityRole="header">
              {FAMILY_TITLE[f.family]}
            </Text>
            <Card padded={false}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', padding: th.space.sm }}>
                {f.defs.map((def) => (
                  <BadgeSeal
                    key={def.id}
                    def={def}
                    earned={byId.get(def.id)}
                    current={badgeCurrent(snapshot.progress, def.metric)}
                    tz={zone}
                    now={now()}
                    animate={fresh.has(def.id)}
                    onPress={() => router.push(badgeHref(def.id))}
                  />
                ))}
              </View>
            </Card>
          </View>
        ))}
      </View>
    );
  }

  return (
    <Screen scroll testID="badges-screen">
      <TripTopBar title={copy.title} onBack={back} />
      {data?.offline ? <Banner testID="badges-offline" tone="info" message={OFFLINE_LINE} /> : null}
      {data !== undefined && rewards.isError ? (
        <Banner
          testID="badges-error"
          tone="danger"
          message={copy.error}
          action={{ label: copy.retry, onPress: () => void rewards.refetch() }}
        />
      ) : null}
      {body}
    </Screen>
  );
}

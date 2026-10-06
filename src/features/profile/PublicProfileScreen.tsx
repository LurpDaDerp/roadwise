import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { statsFrom, type StatId, type StatSums } from '@scoring';
import { TopBar } from '@/features/settings/parts';
import { useHeatmap, useMemberStats, useProfile, useServerAction, type PublicProfile, type Relationship } from '@/features/social/api';
import { isNotFound } from '@/features/social/errors';
import { ReportSheet } from '@/features/social/ReportSheet';
import { Banner, Button, Card, EmptyState, IconButton, Screen, Sheet, Skeleton, StatTile, Text, useTheme, type IconName } from '@/ui';

import { AchievementBadges } from './AchievementBadges';
import { profileCopy } from './copy';
import { ProfileHeader } from './ProfileHeader';
import { RouteHeatMap } from './RouteHeatMap';

const copy = profileCopy.public;

export type RelationAction = 'send' | 'cancel' | 'accept' | 'decline' | 'remove';

/** The buttons a relationship shows, primary first. Self shows none. */
export function relationshipButtons(rel: Relationship): { label: string; action: RelationAction; variant: 'primary' | 'secondary' | 'ghost'; icon: IconName }[] {
  switch (rel) {
    case 'none':
      return [{ label: copy.addFriend, action: 'send', variant: 'primary', icon: 'person-add' }];
    case 'outgoing':
      return [{ label: copy.requested, action: 'cancel', variant: 'secondary', icon: 'time-outline' }];
    case 'incoming':
      return [
        { label: copy.accept, action: 'accept', variant: 'primary', icon: 'checkmark' },
        { label: copy.decline, action: 'decline', variant: 'ghost', icon: 'close' },
      ];
    case 'friend':
      return [{ label: copy.friends, action: 'remove', variant: 'secondary', icon: 'people' }];
    case 'self':
      return [];
  }
}

const RPC: Record<RelationAction, { fn: string; args: (id: string) => Record<string, unknown> }> = {
  send: { fn: 'send_friend_request', args: (id) => ({ p_user_id: id }) },
  cancel: { fn: 'cancel_friend_request', args: (id) => ({ p_user_id: id }) },
  accept: { fn: 'respond_friend_request', args: (id) => ({ p_user_id: id, p_accept: true }) },
  decline: { fn: 'respond_friend_request', args: (id) => ({ p_user_id: id, p_accept: false }) },
  remove: { fn: 'remove_friend', args: (id) => ({ p_user_id: id }) },
};

const STAT_LABELS: Partial<Record<StatId, { label: string; unit: string }>> = {
  speeding: { label: 'Speeding', unit: 'per 100 mi' },
  pickups: { label: 'Phone pickups', unit: 'per 100 mi' },
  harsh: { label: 'Harsh driving', unit: 'per 100 mi' },
  clean: { label: 'Clean drives', unit: '%' },
};

function confirm(title: string, body: string | undefined, yes: string, no: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, body, [
      { text: no, style: 'cancel', onPress: () => resolve(false) },
      { text: yes, style: 'destructive', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

/**
 * `/u/<username>`: another driver's public card, the friend button for where the two of you are,
 * their 30-day stats when you're friends or clanmates, their heat map only if they share it with
 * you, and Report / Block. Not found and blocked look the same.
 */
export function PublicProfileScreen({ username }: { username: string }) {
  const th = useTheme();
  const router = useRouter();
  const profile = useProfile(username);
  const action = useServerAction();
  const [menu, setMenu] = useState(false);
  const [reporting, setReporting] = useState(false);
  const p = profile.data;

  const relate = async (a: RelationAction) => {
    if (!p) return;
    if (a === 'cancel' && !(await confirm(copy.cancelTitle(p.username), undefined, copy.cancelRequest, copy.keep))) return;
    if (a === 'remove' && !(await confirm(copy.removeTitle(p.username), copy.removeBody, copy.remove, copy.keep))) return;
    await action.run(RPC[a].fn, RPC[a].args(p.user_id));
  };

  const block = async () => {
    if (!p) return;
    setMenu(false);
    if (!(await confirm(copy.blockTitle(p.username), copy.blockBody, copy.block, copy.cancel))) return;
    if (await action.run('block_user', { p_user_id: p.user_id })) {
      if (router.canGoBack()) router.back();
    }
  };

  if (!p) {
    const gone = profile.isError && isNotFound(profile.error);
    return (
      <Screen testID="public-profile-screen">
        <TopBar title="" />
        {gone || (!profile.isLoading && !profile.isError && profile.fetchStatus === 'idle') ? (
          <EmptyState icon="person-outline" title={copy.notFound} body={copy.notFoundBody} testID="public-profile-not-found" />
        ) : profile.isError ? (
          <Banner tone="danger" message={profileCopy.loadError} action={{ label: profileCopy.retry, onPress: () => void profile.refetch() }} />
        ) : (
          <Skeleton width="100%" height={240} radius={th.radius.card} />
        )}
      </Screen>
    );
  }

  const others = p.relationship !== 'self';
  return (
    <Screen scroll testID="public-profile-screen">
      <TopBar
        title=""
        trailing={others ? <IconButton icon="ellipsis-horizontal" accessibilityLabel={copy.more} onPress={() => setMenu(true)} testID="profile-more" /> : undefined}
      />
      <ProfileHeader
        username={p.username}
        level={p.level}
        safetyRating={p.safety_rating}
        ranked={p.ranked}
        tier={p.league_tier}
        streak={p.streak}
        clanName={p.clan?.name ?? null}
      />
      {action.error ? <Banner tone="danger" message={action.error} testID="relationship-error" /> : null}
      <RelationshipButtons rel={p.relationship} pending={action.pending !== null} onPress={(a) => void relate(a)} />

      <Card>
        <Text variant="headline">{profileCopy.achievements.title}</Text>
        <AchievementBadges unlocked={p.achievements} testID="public-achievements" />
      </Card>

      {p.can_view_stats && others ? <MemberStats profile={p} /> : null}
      {p.can_view_heatmap && others ? <MemberHeatmap userId={p.user_id} /> : null}

      <Sheet visible={menu} onClose={() => setMenu(false)} title={p.username} testID="profile-menu">
        <Button label={copy.report} icon="flag-outline" variant="secondary" onPress={() => { setMenu(false); setReporting(true); }} testID="profile-report" />
        <Button label={copy.block} icon="ban-outline" variant="destructive" onPress={() => void block()} testID="profile-block" />
      </Sheet>
      <ReportSheet visible={reporting} onClose={() => setReporting(false)} kind="user" targetId={p.user_id} name={p.username} />
    </Screen>
  );
}

export function RelationshipButtons({ rel, pending, onPress }: { rel: Relationship; pending: boolean; onPress: (a: RelationAction) => void }) {
  const th = useTheme();
  const buttons = relationshipButtons(rel);
  if (buttons.length === 0) return null;
  return (
    <View style={{ flexDirection: 'row', gap: th.space.sm }}>
      {buttons.map((b) => (
        <Button
          key={b.action}
          label={b.label}
          icon={b.icon}
          variant={b.variant}
          disabled={pending}
          onPress={() => onPress(b.action)}
          style={{ flex: 1 }}
          testID={`relationship-${b.action}`}
        />
      ))}
    </View>
  );
}

function MemberStats({ profile }: { profile: PublicProfile }) {
  const th = useTheme();
  const stats = useMemberStats(profile.user_id, true);
  const sums: StatSums | undefined = stats.data;
  const home = sums ? statsFrom(sums).filter((s) => s.home) : [];
  return (
    <Card testID="member-stats">
      <Text variant="headline">{copy.stats}</Text>
      {!sums ? (
        <Skeleton width="100%" height={80} />
      ) : sums.drives === 0 ? (
        <Text variant="subhead" tone="muted">
          {copy.statsEmpty}
        </Text>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: th.space.lg }}>
          {home.map((s) => {
            const meta = STAT_LABELS[s.id];
            return (
              <View key={s.id} style={{ width: '50%' }}>
                <StatTile
                  label={meta?.label ?? s.id}
                  value={s.value === null ? '—' : s.unit === 'pct' ? String(Math.round(s.value)) : s.value.toFixed(1)}
                  unit={meta?.unit}
                  health={s.color}
                  higherIsBetter={s.id === 'clean'}
                />
              </View>
            );
          })}
        </View>
      )}
    </Card>
  );
}

function MemberHeatmap({ userId }: { userId: string }) {
  const heat = useHeatmap(userId, true);
  const lines = (heat.data ?? []).map((r) => r.polyline);
  if (heat.isLoading) return <Skeleton width="100%" height={240} />;
  if (lines.length === 0) return null;
  return (
    <Card padded={false} testID="member-heatmap">
      <RouteHeatMap polylines={lines} height={260} />
    </Card>
  );
}

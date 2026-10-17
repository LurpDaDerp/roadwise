import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, Share, View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import { useSession } from '@/data/supabase/session';
import { blockedDuringDrive } from '@/drive/leave';
import { Button, Card, Chip, IconButton, ProgressRing, Screen, SectionHeader, Text, useTheme } from '@/ui';

import {
  BoardRow,
  ListSkeleton,
  LoadFailed,
  RefreshFailedNote,
  RowSeparator,
  usePullRefresh,
} from '../leagues/components';
import { profileHref } from '../leagues/routes';

import { useMyClan, useServerAction, type ClanMember, type MyClan } from './api';
import { BANNER_ART } from './banners';
import { ClanBannerArt, confirm, RoleBadge, showError, TargetMenu, type MenuTarget } from './components';
import { clanCopy } from './copy';
import {
  goalProgress,
  inviteMessage,
  MEMBER_SORTS,
  memberSortValue,
  memberStat,
  ROLE_LABEL,
  sortMembers,
  type MemberSort,
} from './model';
import { CLAN_CREATE_HREF, CLAN_MANAGE_HREF, clanJoinHref } from './routes';

const copy = clanCopy;

// ---------------------------------------------------------------------------
// no clan
// ---------------------------------------------------------------------------

function NoClan() {
  const t = useTheme();
  const router = useRouter();
  const strip = ['sunset', 'ocean', 'gold', 'forest', 'violet'] as const;
  return (
    <ScrollView contentContainerStyle={{ padding: t.space.lg, gap: t.space.xl, flexGrow: 1 }} testID="clan-none">
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ flexDirection: 'row', justifyContent: 'center', paddingTop: t.space.xl }}
      >
        {strip.map((b, i) => (
          <View
            key={b}
            style={{
              width: 64,
              height: 80,
              marginLeft: i === 0 ? 0 : -14,
              borderRadius: t.radius.lg,
              borderCurve: 'continuous',
              backgroundColor: BANNER_ART[b].face[0],
              borderWidth: 3,
              borderColor: t.colors.bg,
              alignItems: 'center',
              justifyContent: 'center',
              transform: [{ rotate: `${(i - 2) * 7}deg` }, { translateY: Math.abs(i - 2) * 6 }],
            }}
          >
            <Ionicons name="shield" size={28} color={BANNER_ART[b].ink} />
          </View>
        ))}
      </View>
      <View style={{ gap: t.space.sm }}>
        <Text variant="title1" accessibilityRole="header" style={{ textAlign: 'center' }}>
          {copy.none.title}
        </Text>
        <Text variant="body" tone="muted" style={{ textAlign: 'center' }}>
          {copy.none.body}
        </Text>
      </View>
      <View style={{ gap: t.space.md }}>
        <Button label={copy.none.create} icon="add" size="lg" onPress={() => router.push(CLAN_CREATE_HREF)} />
        <Button
          label={copy.none.join}
          icon="key-outline"
          variant="secondary"
          size="lg"
          onPress={() => router.push(clanJoinHref())}
        />
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// in a clan
// ---------------------------------------------------------------------------

function GoalCard({ goal }: { goal: MyClan['goal'] }) {
  const t = useTheme();
  const units = useUnits();
  const g = goalProgress(goal, units);
  return (
    <Card testID="clan-goal">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.lg }}>
        <ProgressRing
          value={g.fraction}
          size={88}
          strokeWidth={10}
          tone={g.done ? 'clean' : 'primary'}
          accessibilityLabel={copy.header.goalTitle}
          accessibilityValueText={g.text}
        >
          {g.done ? (
            <Ionicons name="checkmark" size={32} color={t.colors.signal.clean.text} />
          ) : (
            <Text variant="headline">{`${Math.round(g.fraction * 100)}%`}</Text>
          )}
        </ProgressRing>
        <View style={{ flex: 1, gap: t.space.xs }}>
          <Text variant="title3">{copy.header.goalTitle}</Text>
          <Text variant="callout" testID="clan-goal-text">
            {g.text}
          </Text>
          <Text variant="footnote" tone="muted">
            {g.done ? copy.header.goalDone : copy.header.goalHint}
          </Text>
        </View>
      </View>
    </Card>
  );
}

function InviteCard({ clan }: { clan: MyClan['clan'] }) {
  const t = useTheme();
  const regen = useServerAction<void, { invite_code: string }>('regenerate_clan_code');
  const code = clan.invite_code;
  if (!code) return null;

  const share = () => {
    // A share target opens outside RoadWise: not during a drive (src/drive/leave.ts).
    if (blockedDuringDrive()) return;
    void Share.share({ message: inviteMessage(clan.name, code) }).catch(() => {});
  };
  const newCode = async () => {
    const ok = await confirm({
      title: copy.invite.newCodeTitle,
      body: copy.invite.newCodeBody,
      confirmLabel: copy.invite.newCodeConfirm,
    });
    if (!ok) return;
    try {
      await regen.mutateAsync();
    } catch (err) {
      showError(err);
    }
  };

  return (
    <Card testID="clan-invite">
      <Text variant="title3">{copy.invite.title}</Text>
      <Text variant="callout" tone="muted">
        {copy.invite.body}
      </Text>
      <View
        accessible
        accessibilityLabel={copy.invite.codeLabel(code)}
        style={{
          alignItems: 'center',
          paddingVertical: t.space.md,
          borderRadius: t.radius.lg,
          borderCurve: 'continuous',
          backgroundColor: t.colors.surfaceRaised,
        }}
      >
        <Text variant="stat" style={{ letterSpacing: 6 }} testID="clan-code" selectable>
          {code}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: t.space.sm }}>
        <Button label={copy.invite.share} icon="share-outline" onPress={share} style={{ flex: 1 }} testID="clan-share" />
        <Button
          label={copy.invite.newCode}
          icon="refresh"
          variant="secondary"
          loading={regen.isPending}
          onPress={() => void newCode()}
          testID="clan-new-code"
        />
      </View>
    </Card>
  );
}

function InClan({ clan, refetch, refreshFailed }: { clan: MyClan; refetch: () => Promise<unknown>; refreshFailed: boolean }) {
  const t = useTheme();
  const router = useRouter();
  const { session } = useSession();
  const myId = session?.user.id ?? '';
  const [sort, setSort] = useState<MemberSort>('rating');
  const units = useUnits();
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const pull = usePullRefresh(refetch);
  const members = useMemo(() => sortMembers(clan.members, sort), [clan.members, sort]);
  const openMenu = (m: ClanMember) => setMenu({ kind: 'user', id: m.user_id, username: m.username });

  const header = (
    <View style={{ gap: t.space.lg, paddingBottom: t.space.md }}>
      {refreshFailed ? <RefreshFailedNote /> : null}
      <ClanBannerArt
        banner={clan.clan.banner}
        name={clan.clan.name}
        subtitle={copy.header.members(clan.clan.member_count)}
        testID="clan-banner"
      >
        <View style={{ flexDirection: 'row' }}>
          <RoleBadge role={clan.my_role} accessible />
        </View>
      </ClanBannerArt>
      <GoalCard goal={clan.goal} />
      <InviteCard clan={clan.clan} />
      <SectionHeader title={copy.members.title} action={{ label: copy.members.manage, onPress: () => router.push(CLAN_MANAGE_HREF) }} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: t.space.sm, paddingHorizontal: t.space.lg }}
        accessibilityLabel={copy.members.sortLabel}
        style={{ marginHorizontal: -t.space.lg }}
      >
        {MEMBER_SORTS.map((s) => (
          <Chip key={s.key} label={s.label} selected={sort === s.key} onPress={() => setSort(s.key)} testID={`sort-${s.key}`} />
        ))}
      </ScrollView>
    </View>
  );

  return (
    <>
      <FlatList
        testID="clan-members"
        data={members}
        keyExtractor={(m) => m.user_id}
        contentContainerStyle={{ padding: t.space.lg }}
        ItemSeparatorComponent={RowSeparator}
        ListHeaderComponent={header}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={t.colors.accent} />}
        renderItem={({ item, index }) => {
          const stat = memberStat(item, sort, units);
          const me = item.user_id === myId;
          return (
            <BoardRow
              rank={memberSortValue(item, sort) === null ? null : index + 1}
              username={item.username}
              subtitle={`Level ${item.level}`}
              value={stat.value}
              unit={stat.unit}
              valueLabel={stat.spoken}
              me={me}
              badge={<RoleBadge role={item.role} />}
              badgeLabel={item.role === 'member' ? undefined : ROLE_LABEL[item.role]}
              onPress={() => router.push(profileHref(item.username))}
              onLongPress={me ? undefined : () => openMenu(item)}
              accessibilityHint={me ? undefined : 'Long press for more options'}
              accessory={
                me ? undefined : (
                  <IconButton
                    icon="ellipsis-horizontal"
                    accessibilityLabel={copy.members.more(item.username)}
                    onPress={() => openMenu(item)}
                    testID={`more-${item.username}`}
                  />
                )
              }
              testID={`member-${item.username}`}
            />
          );
        }}
      />
      <TargetMenu target={menu} onClose={() => setMenu(null)} />
    </>
  );
}

/** The Clan tab: create or join when you have none; banner, goal, invite and members when you do. */
export function ClanScreen() {
  const t = useTheme();
  const q = useMyClan();

  let body;
  if (q.data === undefined) {
    body = (
      <View style={{ padding: t.space.lg }}>
        {q.isError ? <LoadFailed onRetry={() => void q.refetch()} /> : <ListSkeleton rows={4} />}
      </View>
    );
  } else if (q.data === null) {
    body = <NoClan />;
  } else {
    body = <InClan clan={q.data} refetch={q.refetch} refreshFailed={q.isError} />;
  }

  return (
    <Screen padded={false} bottomInset={false} sky testID="clan-screen">
      <View style={{ paddingHorizontal: t.space.lg, paddingTop: t.space.lg }}>
        <Text variant="title1" accessibilityRole="header">
          {copy.title}
        </Text>
      </View>
      <View style={{ flex: 1 }}>{body}</View>
    </Screen>
  );
}

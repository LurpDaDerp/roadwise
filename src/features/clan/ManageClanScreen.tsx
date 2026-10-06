import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useSession } from '@/data/supabase/session';
import { Avatar, Button, Card, Divider, ListRow, Screen, Sheet, Text, useTheme } from '@/ui';

import { ListSkeleton, LoadFailed } from '../leagues/components';

import { useMyClan, useServerAction, type ClanMember, type MyClan } from './api';
import { confirm, RoleBadge, showError, TargetMenu, TopBar, type MenuTarget } from './components';
import { clanCopy } from './copy';
import { leaveMessage, manageActions, ROLE_LABEL, type ManageAction } from './model';
import { CLAN_TAB_HREF } from './routes';

const copy = clanCopy.manage;

const ACTION_COPY: Record<ManageAction, { label: string; icon: keyof typeof Ionicons.glyphMap; danger?: boolean }> = {
  promote: { label: copy.promote, icon: 'arrow-up-circle-outline' },
  demote: { label: copy.demote, icon: 'arrow-down-circle-outline' },
  transfer: { label: copy.transfer, icon: 'star-outline' },
  remove: { label: copy.remove, icon: 'person-remove-outline', danger: true },
};

function MemberActions({ member, myRole, onClose }: { member: ClanMember | null; myRole: MyClan['my_role']; onClose: () => void }) {
  const t = useTheme();
  const setRole = useServerAction<{ p_user_id: string; p_role: 'coleader' | 'member' }>('set_member_role');
  const transfer = useServerAction<{ p_user_id: string }>('transfer_leadership');
  const remove = useServerAction<{ p_user_id: string }>('remove_member');
  const busy = setRole.isPending || transfer.isPending || remove.isPending;
  if (!member) return null;

  const run = async (action: ManageAction) => {
    const id = { p_user_id: member.user_id };
    if (action === 'transfer') {
      const ok = await confirm({
        title: copy.transferTitle(member.username),
        body: copy.transferBody,
        confirmLabel: copy.transfer,
      });
      if (!ok) return;
    }
    if (action === 'remove') {
      const ok = await confirm({
        title: copy.removeTitle(member.username),
        body: copy.removeBody,
        confirmLabel: copy.remove,
        destructive: true,
      });
      if (!ok) return;
    }
    try {
      if (action === 'promote') await setRole.mutateAsync({ ...id, p_role: 'coleader' });
      if (action === 'demote') await setRole.mutateAsync({ ...id, p_role: 'member' });
      if (action === 'transfer') await transfer.mutateAsync(id);
      if (action === 'remove') await remove.mutateAsync(id);
      onClose();
    } catch (err) {
      showError(err);
    }
  };

  const actions = manageActions(myRole, member);
  return (
    <Sheet visible onClose={onClose} title={member.username} testID="member-actions">
      <Card padded={false} variant="raised">
        {actions.map((a, i) => (
          <View key={a}>
            {i > 0 ? <Divider inset={16} /> : null}
            <ListRow
              title={ACTION_COPY[a].label}
              leading={
                <Ionicons
                  name={ACTION_COPY[a].icon}
                  size={t.size.icon}
                  color={ACTION_COPY[a].danger ? t.colors.danger : t.colors.accent}
                />
              }
              onPress={busy ? undefined : () => void run(a)}
              accessory="none"
              testID={`action-${a}`}
            />
          </View>
        ))}
      </Card>
    </Sheet>
  );
}

/** Roles, removals and leaving: what each role may do mirrors the server's checks. */
export function ManageClanScreen() {
  const t = useTheme();
  const router = useRouter();
  const { session } = useSession();
  const myId = session?.user.id ?? '';
  const q = useMyClan();
  const leave = useServerAction<void>('leave_clan');
  const [selected, setSelected] = useState<ClanMember | null>(null);
  const [report, setReport] = useState<MenuTarget | null>(null);

  const clan = q.data;
  if (clan === undefined || clan === null) {
    return (
      <Screen testID="clan-manage">
        <TopBar title={copy.title} />
        {q.isError ? <LoadFailed onRetry={() => void q.refetch()} /> : null}
        {clan === undefined && !q.isError ? <ListSkeleton rows={4} /> : null}
        {clan === null ? <Text tone="muted">{clanCopy.none.body}</Text> : null}
      </Screen>
    );
  }

  const others = clan.members.filter((m) => m.user_id !== myId);
  const canManage = clan.my_role !== 'member';

  const onLeave = async () => {
    const ok = await confirm({
      title: copy.leaveTitle,
      body: leaveMessage(clan, myId),
      confirmLabel: copy.leave,
      destructive: true,
    });
    if (!ok) return;
    try {
      await leave.mutateAsync();
      router.replace(CLAN_TAB_HREF);
    } catch (err) {
      showError(err);
    }
  };

  return (
    <Screen scroll testID="clan-manage">
      <TopBar title={copy.title} />
      <View style={{ gap: t.space.sm }}>
        <Text variant="title3">{copy.membersTitle}</Text>
        {canManage && others.length > 0 ? (
          <Text variant="footnote" tone="muted">
            {copy.roleHint}
          </Text>
        ) : null}
      </View>
      {others.length === 0 ? (
        <Text variant="callout" tone="muted">
          {copy.noOne}
        </Text>
      ) : (
        <Card padded={false}>
          {others.map((m, i) => {
            const actions = manageActions(clan.my_role, m);
            return (
              <View key={m.user_id}>
                {i > 0 ? <Divider inset={68} /> : null}
                <ListRow
                  title={m.username}
                  subtitle={ROLE_LABEL[m.role]}
                  leading={<Avatar username={m.username} size="md" />}
                  trailing={<RoleBadge role={m.role} />}
                  onPress={actions.length > 0 ? () => setSelected(m) : undefined}
                  accessibilityHint={actions.length > 0 ? 'Change role or remove' : undefined}
                  testID={`manage-${m.username}`}
                />
              </View>
            );
          })}
        </Card>
      )}
      <View style={{ flex: 1 }} />
      <View style={{ gap: t.space.sm }}>
        <Button
          label={copy.reportClan}
          variant="ghost"
          icon="flag-outline"
          onPress={() => setReport({ kind: 'clan', id: clan.clan.id, name: clan.clan.name })}
          testID="report-clan"
        />
        <Button
          label={copy.leave}
          variant="destructive"
          icon="exit-outline"
          loading={leave.isPending}
          onPress={() => void onLeave()}
          testID="leave-clan"
        />
      </View>
      <MemberActions member={selected} myRole={clan.my_role} onClose={() => setSelected(null)} />
      <TargetMenu target={report} onClose={() => setReport(null)} />
    </Screen>
  );
}

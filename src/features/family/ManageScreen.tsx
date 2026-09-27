import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { Alert, Share, View } from 'react-native';

import { TripTopBar } from '@/features/trips/TopBar';
import { Banner, Button, Card, ListRow, Screen, Skeleton, Text, useTheme } from '@/ui';

import type { Family, FamilyMember } from './api';
import { familyCopy as copy, spacedCode, spokenCode } from './copy';
import { errorText, FieldLabel } from './parts';
import { memberName } from './presence';
import { useFamily, useFamilyActions, type FamilyDeps } from './useFamily';

const FAMILY_TAB = '/(tabs)/family' as Href;

export interface ManageDeps extends FamilyDeps {
  share?: (content: { message: string }) => Promise<unknown>;
  alert?: typeof Alert.alert;
}

/** "Sat 4 Oct" for the code's expiry. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * Family settings: the join code (the admin: share it, or replace it), the members (the admin can
 * remove anyone else), and Leave. Every removal asks first and says what it deletes.
 */
export function ManageScreen({ deps = {} }: { deps?: ManageDeps }) {
  const th = useTheme();
  const router = useRouter();
  const family = useFamily(deps);
  const leaveScreen = () => (router.canGoBack() ? router.back() : router.replace(FAMILY_TAB));
  const data = family.data?.family;

  let body;
  if (family.data === undefined && family.isError) {
    body = (
      <Banner tone="danger" message={errorText(family.error)} action={{ label: copy.retry, onPress: () => void family.refetch() }} />
    );
  } else if (family.data === undefined) {
    body = (
      <View accessible accessibilityRole="progressbar" accessibilityLabel={copy.loading}>
        <Skeleton width="100%" height={120} />
      </View>
    );
  } else if (data === null || data === undefined) {
    // Left, or removed: nothing to manage.
    body = <Text variant="body">{copy.errors.not_in_family}</Text>;
  } else {
    body = <Manage family={data} deps={deps} onLeft={() => router.replace(FAMILY_TAB)} />;
  }

  return (
    <Screen scroll testID="family-manage-screen">
      <TripTopBar title={copy.manage.title} onBack={leaveScreen} />
      <View style={{ gap: th.space.lg }}>{body}</View>
    </Screen>
  );
}

function Manage({ family, deps, onLeft }: { family: Family; deps: ManageDeps; onLeft: () => void }) {
  const th = useTheme();
  const actions = useFamilyActions(deps);
  const [error, setError] = useState<string | null>(null);
  const alert = deps.alert ?? Alert.alert;
  const admin = family.myRole === 'admin';
  const alone = family.members.length === 1;

  const share = async () => {
    if (family.code === null) return;
    try {
      await (deps.share ?? ((c) => Share.share(c)))({ message: copy.manage.shareMessage(family.name, family.code) });
    } catch {
      // Dismissed: nothing was sent.
    }
  };
  const confirm = (title: string, body: string, label: string, run: () => void) =>
    alert(title, body, [
      { text: copy.manage.cancel, style: 'cancel' },
      { text: label, style: 'destructive', onPress: run },
    ]);
  const remove = (m: FamilyMember) =>
    confirm(copy.manage.removeTitle(memberName(m)), copy.manage.removeBody, copy.manage.removeConfirm, () => {
      setError(null);
      actions.remove.mutate(m.userId, { onError: (e) => setError(errorText(e)) });
    });
  const leave = () =>
    confirm(copy.manage.leaveTitle, alone ? copy.manage.leaveBodyLast : copy.manage.leaveBody, copy.manage.leaveConfirm, () => {
      setError(null);
      actions.leave.mutate(undefined, { onSuccess: onLeft, onError: (e) => setError(errorText(e)) });
    });

  return (
    <>
      {error ? <Banner tone="danger" message={error} testID="family-manage-error" /> : null}
      {admin && family.code !== null ? (
        <Card variant="license" testID="family-code-card">
          <View style={{ gap: th.space.sm }}>
            <FieldLabel>{copy.manage.codeLabel}</FieldLabel>
            <View accessible accessibilityRole="text" accessibilityLabel={copy.manage.codeSpoken(spokenCode(family.code))} testID="family-code">
              <Text variant="display" selectable style={{ letterSpacing: 2 }}>
                {spacedCode(family.code)}
              </Text>
            </View>
            {family.codeExpiresAt !== null ? (
              <Text variant="subhead" tone="muted">
                {copy.manage.codeExpires(dayLabel(family.codeExpiresAt))}
              </Text>
            ) : null}
            <Button label={copy.manage.share} onPress={() => void share()} testID="family-share-code" />
            <Button
              label={copy.manage.rotate}
              variant="ghost"
              size="md"
              accessibilityHint={copy.manage.rotateHint}
              loading={actions.rotate.isPending}
              onPress={() => actions.rotate.mutate(undefined, { onError: (e) => setError(errorText(e)) })}
              testID="family-rotate-code"
            />
          </View>
        </Card>
      ) : null}
      <View style={{ gap: th.space.xs }}>
        <Text variant="headline" accessibilityRole="header">
          {copy.manage.membersLabel}
        </Text>
        <Text variant="subhead" tone="muted">
          {copy.manage.memberCount(family.members.length)}
        </Text>
        {family.members.map((m) => (
          <ListRow
            key={m.userId}
            title={memberName(m)}
            subtitle={m.role === 'admin' ? copy.home.admin : undefined}
            accessory="none"
            trailing={
              admin && !m.isMe ? (
                <Button
                  label={copy.manage.remove}
                  variant="ghost"
                  size="md"
                  onPress={() => remove(m)}
                  testID={`family-remove-${m.userId}`}
                />
              ) : undefined
            }
            testID={`family-manage-member-${m.userId}`}
          />
        ))}
      </View>
      <Button label={copy.manage.leave} variant="destructive" onPress={leave} loading={actions.leave.isPending} testID="family-leave" />
    </>
  );
}

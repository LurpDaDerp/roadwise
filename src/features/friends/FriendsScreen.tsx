import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Section, TopBar } from '@/features/settings/parts';
import { useFriends, useServerAction, type PublicCard } from '@/features/social/api';
import { profileHref } from '@/features/social/links';
import { Avatar, Banner, Button, EmptyState, ListRow, Skeleton, useTheme } from '@/ui';

import { friendsCopy as copy } from './copy';

export const ADD_FRIENDS_HREF = '/friends/add' as Href;

const subtitle = (c: PublicCard) => copy.rating(c.ranked ? c.safety_rating : null);

/**
 * `/friends`: requests to answer first, then friends, then requests you sent (each cancellable).
 * Tapping anyone opens their profile, where a friend can be removed.
 */
export function FriendsScreen() {
  const th = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const friends = useFriends();
  const action = useServerAction();
  const [busyId, setBusyId] = useState<string | null>(null);
  const data = friends.data;

  const act = (id: string, fn: string, args: Record<string, unknown>) => {
    setBusyId(id);
    void action.run(fn, args).finally(() => setBusyId(null));
  };

  const open = (u: string) => router.push(profileHref(u));
  const empty = data && data.friends.length + data.incoming.length + data.outgoing.length === 0;

  return (
    <ScrollView
      testID="friends-screen"
      style={{ flex: 1, backgroundColor: th.colors.bg }}
      contentContainerStyle={{ padding: th.space.lg, paddingTop: th.space.lg + insets.top, paddingBottom: th.space.lg + insets.bottom, gap: th.space.xl }}
      refreshControl={<RefreshControl refreshing={friends.isRefetching} onRefresh={() => void friends.refetch()} tintColor={th.colors.accent} />}
    >
      <TopBar title={copy.title} />
      <Button label={copy.add} icon="person-add" onPress={() => router.push(ADD_FRIENDS_HREF)} testID="friends-add" />
      {action.error ? <Banner tone="danger" message={action.error} testID="friends-action-error" /> : null}

      {!data ? (
        friends.isError ? (
          <Banner tone="danger" message={copy.loadError} action={{ label: copy.retry, onPress: () => void friends.refetch() }} testID="friends-load-error" />
        ) : (
          <Skeleton width="100%" height={120} />
        )
      ) : empty ? (
        <EmptyState icon="people-outline" title={copy.empty} body={copy.emptyBody} testID="friends-empty" />
      ) : (
        <>
          {data.incoming.length > 0 ? (
            <Section title={copy.incoming} testID="friends-incoming">
              {data.incoming.map((c) => (
                <View key={c.user_id}>
                  <ListRow
                    title={c.username}
                    subtitle={subtitle(c)}
                    leading={<Avatar username={c.username} size="md" />}
                    onPress={() => open(c.username)}
                    accessory="none"
                    testID={`incoming-${c.username}`}
                  />
                  <View style={{ flexDirection: 'row', gap: th.space.sm, paddingHorizontal: th.space.lg, paddingBottom: th.space.md }}>
                    <Button
                      label={copy.accept}
                      icon="checkmark"
                      size="sm"
                      variant="secondary"
                      loading={busyId === c.user_id && action.pending === 'respond_friend_request'}
                      disabled={busyId !== null}
                      onPress={() => act(c.user_id, 'respond_friend_request', { p_user_id: c.user_id, p_accept: true })}
                      accessibilityHint={copy.acceptHint(c.username)}
                      style={{ flex: 1 }}
                      testID={`accept-${c.username}`}
                    />
                    <Button
                      label={copy.decline}
                      size="sm"
                      variant="ghost"
                      disabled={busyId !== null}
                      onPress={() => act(c.user_id, 'respond_friend_request', { p_user_id: c.user_id, p_accept: false })}
                      accessibilityHint={copy.declineLabel(c.username)}
                      style={{ flex: 1 }}
                      testID={`decline-${c.username}`}
                    />
                  </View>
                </View>
              ))}
            </Section>
          ) : null}

          {data.friends.length > 0 ? (
            <Section title={`${copy.friends} · ${data.friends.length}`} testID="friends-list">
              {data.friends.map((c) => (
                <ListRow
                  key={c.user_id}
                  title={c.username}
                  subtitle={subtitle(c)}
                  leading={<Avatar username={c.username} size="md" />}
                  onPress={() => open(c.username)}
                  testID={`friend-${c.username}`}
                />
              ))}
            </Section>
          ) : null}

          {data.outgoing.length > 0 ? (
            <Section title={copy.outgoing} testID="friends-outgoing">
              {data.outgoing.map((c) => (
                // Cancel sits beside the row, not inside it: the row is one button for VoiceOver,
                // which would hide a button nested in it.
                <View key={c.user_id} style={{ flexDirection: 'row', alignItems: 'center', paddingRight: th.space.lg }}>
                  <View style={{ flex: 1 }}>
                    <ListRow
                      title={c.username}
                      leading={<Avatar username={c.username} size="sm" />}
                      onPress={() => open(c.username)}
                      accessory="none"
                      testID={`outgoing-${c.username}`}
                    />
                  </View>
                  <Button
                    label={copy.cancel}
                    size="sm"
                    variant="ghost"
                    loading={busyId === c.user_id}
                    disabled={busyId !== null}
                    onPress={() => act(c.user_id, 'cancel_friend_request', { p_user_id: c.user_id })}
                    accessibilityHint={copy.cancelHint(c.username)}
                    testID={`cancel-${c.username}`}
                  />
                </View>
              ))}
            </Section>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

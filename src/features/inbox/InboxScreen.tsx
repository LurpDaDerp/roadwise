import { Ionicons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ICON, TOUCH } from '@/features/trips/layout';
import { TRIP_HISTORY_HREF } from '@/features/trips/routes';
import { TripTopBar } from '@/features/trips/TopBar';
import { Banner, Button, Card, EmptyState, Screen, Skeleton, useTheme } from '@/ui';

import { inboxCopy as copy } from './copy';
import { InboxRow } from './InboxRow';
import { useDismiss, useInboxItems, useMarkAllRead, useMarkRead, type InboxDeps } from './useInbox';
import type { InboxItemView } from './viewModel';

/** H6, notification settings (Task 7's route). Cast: typed routes are generated at `expo start`. */
export const NOTIFICATION_SETTINGS_HREF = '/settings/notifications' as Href;

/**
 * B3 · Inbox: every notification, mirrored (§11.1 rule 4), newest first, each drive told from its
 * current state. No primary action: the screen is a record to read, not a task.
 */
export function InboxScreen({ deps = {}, tz }: { deps?: InboxDeps; tz?: string }) {
  const th = useTheme();
  const router = useRouter();
  const { inbox, locals, items, offline } = useInboxItems(deps, tz);
  const markRead = useMarkRead(deps);
  const dismiss = useDismiss(deps);
  const markAll = useMarkAllRead(deps);
  const [actionFailed, setActionFailed] = useState(false);

  const unread = items?.filter((i) => i.unread).length ?? 0;

  const run = (work: Promise<unknown>) => {
    setActionFailed(false);
    work.catch(() => setActionFailed(true));
  };

  const onOpen = (item: InboxItemView) => {
    if (item.unread) run(markRead.mutateAsync([item.id]));
    if (item.href) router.push(item.href);
  };
  const onDismiss = (item: InboxItemView) => run(dismiss.mutateAsync([item.id]));

  const back = router.canGoBack() ? () => router.back() : null;

  const trailing = (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {unread > 0 ? (
        <Button
          testID="inbox-mark-all"
          label={copy.markAllRead}
          variant="ghost"
          size="md"
          onPress={() => run(markAll.markAll())}
        />
      ) : null}
      <Pressable
        testID="inbox-settings"
        accessibilityRole="button"
        accessibilityLabel={copy.settings}
        onPress={() => router.push(NOTIFICATION_SETTINGS_HREF)}
        hitSlop={th.space.xs}
        style={({ pressed }) => ({
          width: TOUCH,
          height: TOUCH,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: th.radius.pill,
          backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
        })}
      >
        <Ionicons name="settings-outline" size={ICON.sm + 6} color={th.colors.accent} />
      </Pressable>
    </View>
  );

  const failed = inbox.isError || locals.isError;
  const retry = () => {
    void inbox.refetch();
    if (locals.isError) void locals.refetch();
  };

  let body;
  if (items === undefined && failed) {
    body = (
      <Banner
        testID="inbox-error"
        tone="danger"
        message={copy.error}
        action={{ label: copy.retry, onPress: retry }}
      />
    );
  } else if (items === undefined) {
    body = (
      <Card padded={false} testID="inbox-loading">
        {[0, 1, 2].map((i) => (
          <View
            key={i}
            style={{
              padding: th.space.lg,
              gap: th.space.sm,
              borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
              borderTopColor: th.colors.divider,
            }}
          >
            <Skeleton width="55%" height={18} />
            <Skeleton width="85%" height={14} />
            <Skeleton width="30%" height={12} />
          </View>
        ))}
      </Card>
    );
  } else if (items.length === 0) {
    body = (
      <EmptyState
        testID="inbox-empty"
        title={copy.empty.title}
        body={copy.empty.body}
        action={{ label: copy.empty.action, onPress: () => router.push(TRIP_HISTORY_HREF) }}
      />
    );
  } else {
    body = (
      <Card padded={false} testID="inbox-list">
        {items.map((item, i) => (
          <View
            key={item.id}
            style={{
              borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
              borderTopColor: th.colors.divider,
            }}
          >
            <InboxRow item={item} onOpen={onOpen} onDismiss={onDismiss} />
          </View>
        ))}
      </Card>
    );
  }

  return (
    <Screen scroll testID="inbox-screen">
      <TripTopBar title={copy.title} onBack={back} trailing={trailing} />
      {offline ? <Banner testID="inbox-offline" tone="info" message={copy.offline} /> : null}
      {items !== undefined && failed ? (
        <Banner
          testID="inbox-error"
          tone="danger"
          message={copy.error}
          action={{ label: copy.retry, onPress: retry }}
        />
      ) : null}
      {actionFailed ? (
        <Banner testID="inbox-action-failed" tone="warning" message={copy.actionFailed} />
      ) : null}
      {body}
    </Screen>
  );
}

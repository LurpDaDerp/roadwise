import { useState } from 'react';

import { Avatar, Banner, Button, EmptyState, ListRow, Screen, Skeleton, Text } from '@/ui';
import { useBlocked, useServerAction } from '@/features/social/api';

import { settingsCopy } from './copy';
import { Section, TopBar } from './parts';

const copy = settingsCopy.blocked;

/** `/settings/blocked`: everyone this driver has blocked, each with Unblock. */
export function BlockedScreen() {
  const blocked = useBlocked();
  const action = useServerAction();
  const [pendingFor, setPendingFor] = useState<string | null>(null);
  const list = blocked.data;

  let body;
  if (list === undefined) {
    body = blocked.isError ? (
      <Banner
        tone="danger"
        message={copy.loadError}
        action={{ label: copy.retry, onPress: () => void blocked.refetch() }}
        testID="blocked-load-error"
      />
    ) : (
      <Skeleton width="100%" height={56} />
    );
  } else if (list.length === 0) {
    body = <EmptyState icon="ban-outline" title={copy.empty} body={copy.emptyBody} testID="blocked-empty" />;
  } else {
    body = (
      <Section testID="blocked-list">
        {list.map((u) => (
          <ListRow
            key={u.user_id}
            title={u.username}
            leading={<Avatar username={u.username} size="sm" />}
            trailing={
              <Button
                label={copy.unblock}
                size="sm"
                variant="secondary"
                loading={action.pending !== null && pendingFor === u.user_id}
                onPress={() => {
                  setPendingFor(u.user_id);
                  void action.run('unblock_user', { p_user_id: u.user_id });
                }}
                accessibilityHint={copy.unblockLabel(u.username)}
                testID={`unblock-${u.username}`}
              />
            }
            accessibilityLabel={u.username}
            testID={`blocked-${u.username}`}
          />
        ))}
      </Section>
    );
  }

  return (
    <Screen scroll testID="blocked-screen">
      <TopBar title={copy.title} />
      <Text variant="body" tone="muted">
        {copy.intro}
      </Text>
      {action.error ? <Banner tone="danger" message={action.error} testID="blocked-action-error" /> : null}
      {body}
    </Screen>
  );
}

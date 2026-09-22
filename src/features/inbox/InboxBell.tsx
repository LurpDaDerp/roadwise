import { Ionicons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
import { Pressable, View } from 'react-native';

import { ICON, TOUCH } from '@/features/trips/layout';
import { Text, useTheme } from '@/ui';

import { inboxCopy as copy } from './copy';
import { useUnreadCount, type InboxDeps } from './useInbox';

/** B3. Cast: typed routes are generated at `expo start`, after this route was added. */
export const INBOX_HREF = '/inbox' as Href;

/** The badge prints at most this, then "9+". */
const BADGE_MAX = 9;

/**
 * The header bell (Home, Task 18 mounts it). The unread count is printed as a number on the badge
 * and spoken in the label ("Inbox, 2 unread"), so it never rides on colour. It reads the inbox the
 * cache already holds; mounting it fetches only when that is older than five minutes.
 */
export function InboxBell({ deps }: { deps?: InboxDeps }) {
  const th = useTheme();
  const router = useRouter();
  const unread = useUnreadCount(deps);
  const label = unread > 0 ? copy.bell.unread(unread) : copy.bell.none;

  return (
    <Pressable
      testID="inbox-bell"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={copy.bell.hint}
      onPress={() => router.push(INBOX_HREF)}
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
      <Ionicons
        name={unread > 0 ? 'notifications' : 'notifications-outline'}
        size={ICON.sm + 8}
        color={th.colors.accent}
      />
      {unread > 0 ? (
        <View
          testID="inbox-bell-badge"
          style={{
            position: 'absolute',
            top: 4,
            right: 2,
            minWidth: 18,
            height: 18,
            paddingHorizontal: 4,
            borderRadius: th.radius.pill,
            backgroundColor: th.colors.stamp,
            borderWidth: 1.5,
            borderColor: th.colors.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text
            variant="caption"
            style={{ color: th.colors.textInverse, fontWeight: '700', lineHeight: 14, fontSize: 11 }}
          >
            {unread > BADGE_MAX ? `${BADGE_MAX}+` : String(unread)}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

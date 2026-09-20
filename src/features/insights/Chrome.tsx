import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';

import { Banner, Card, Skeleton, Text, useTheme } from '@/ui';

import { insightsCopy as copy } from './copy';

/**
 * The screen's own title bar. The stack draws no native header (see `app/(app)/_layout.tsx`), so
 * each screen prints its title as the one `header` element and carries its own Back — the same
 * construction the trip screens use, so the two groups feel like one book.
 */
export function TopBar({ title, testID }: { title: string; testID?: string }) {
  const th = useTheme();
  const router = useRouter();
  const back = router.canGoBack() ? () => router.back() : null;

  return (
    <View
      testID={testID}
      style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm, minHeight: 44 }}
    >
      {back ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.back}
          onPress={back}
          hitSlop={th.space.sm}
          style={({ pressed }) => ({
            minWidth: 44,
            minHeight: 44,
            alignItems: 'center',
            justifyContent: 'center',
            marginLeft: -th.space.sm,
            borderRadius: th.radius.pill,
            backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
          })}
        >
          <Ionicons name="chevron-back" size={26} color={th.colors.accent} />
        </Pressable>
      ) : null}
      <Text variant="title1" accessibilityRole="header" style={{ flex: 1 }}>
        {title}
      </Text>
    </View>
  );
}

/**
 * §7.0: a skeleton in the shape of what is coming, never a spinner. The card face, the trend's
 * band, and two ruled blocks — the page the driver is about to read, unprinted.
 */
export function InsightsSkeleton({ testID }: { testID?: string }) {
  const th = useTheme();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={copy.loading}
      testID={testID}
      style={{ gap: th.space.lg }}
    >
      <Skeleton width={220} height={44} radius={th.radius.sm} />
      <Card variant="license">
        <Skeleton width="45%" height={14} />
        <Skeleton width={120} height={40} />
        <Skeleton width="100%" height={170} radius={th.radius.sm} />
      </Card>
      <Card>
        <Skeleton width="40%" height={14} />
        <Skeleton width="100%" height={88} radius={th.radius.sm} />
      </Card>
    </View>
  );
}

/** §7.0: plain language in place, with a retry. No error codes in the primary text. */
export function ReadError({ onRetry }: { onRetry: () => void }) {
  return (
    <Banner
      tone="danger"
      message={copy.error.message}
      action={{ label: copy.error.retry, onPress: onRetry }}
      testID="insights-error"
    />
  );
}

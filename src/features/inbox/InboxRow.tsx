import { Ionicons } from '@expo/vector-icons';
import { Pressable, View, type AccessibilityActionEvent } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

import { ICON, TIGHT, TOUCH } from '@/features/trips/layout';
import { Text, useTheme } from '@/ui';

import { inboxCopy as copy } from './copy';
import type { InboxItemView } from './viewModel';

/**
 * One ruled line of the inbox record.
 *
 * Dismissal has three equal paths, so none of them is the only way (brief: swipe AND an
 * accessibility action AND a visible control): a swipe to the left, the screen reader's
 * "Dismiss" action on the row, and the ✕ button at the row's end, which is its own 44 pt target
 * outside the row's press area so VoiceOver and TalkBack reach it too.
 *
 * Unread is never colour alone: an unread row prints its title heavier and carries a stamp dot,
 * and its spoken label starts with "Unread."
 */
export function InboxRow({
  item,
  onOpen,
  onDismiss,
}: {
  item: InboxItemView;
  onOpen: (item: InboxItemView) => void;
  onDismiss: (item: InboxItemView) => void;
}) {
  const th = useTheme();

  const onAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'dismiss') onDismiss(item);
    else if (event.nativeEvent.actionName === 'activate') onOpen(item);
  };

  const renderDismiss = () => (
    <View
      style={{
        justifyContent: 'center',
        alignItems: 'flex-end',
        paddingHorizontal: th.space.xl,
        backgroundColor: th.colors.accentFaint,
        minWidth: 120,
      }}
    >
      <Text variant="headline" tone="accent">
        {copy.dismiss}
      </Text>
    </View>
  );

  return (
    <ReanimatedSwipeable
      testID={`inbox-swipe-${item.id}`}
      renderRightActions={renderDismiss}
      rightThreshold={80}
      friction={1.5}
      onSwipeableOpen={() => onDismiss(item)}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          backgroundColor: th.colors.surface,
        }}
      >
        <Pressable
          testID={`inbox-row-${item.id}`}
          accessibilityRole={item.href ? 'button' : undefined}
          accessibilityLabel={item.accessibilityLabel}
          accessibilityHint={item.href ? copy.open : undefined}
          accessibilityActions={[
            { name: 'activate' },
            { name: 'dismiss', label: copy.dismiss },
          ]}
          onAccessibilityAction={onAction}
          onPress={() => onOpen(item)}
          style={({ pressed }) => ({
            flex: 1,
            flexDirection: 'row',
            gap: th.space.md,
            paddingVertical: th.space.md,
            paddingLeft: th.space.lg,
            minHeight: 64,
            backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
          })}
        >
          <View style={{ width: ICON.xs / 2 + 2, paddingTop: 7, alignItems: 'center' }}>
            {item.unread ? (
              <View
                testID={`inbox-unread-${item.id}`}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: th.radius.pill,
                  backgroundColor: th.colors.stamp,
                }}
              />
            ) : null}
          </View>
          <View style={{ flex: 1, gap: TIGHT }}>
            <Text variant={item.unread ? 'headline' : 'body'}>{item.title}</Text>
            <Text variant="subhead" tone="muted">
              {item.body}
            </Text>
            {item.dispute ? <Text variant="footnote">{item.dispute}</Text> : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.sm, marginTop: TIGHT }}>
              <Text variant="caption" tone="subtle" style={{ fontVariant: ['tabular-nums'] }}>
                {item.when}
              </Text>
              {item.note ? (
                <Text variant="caption" tone="subtle">
                  {`· ${item.note}`}
                </Text>
              ) : null}
            </View>
          </View>
        </Pressable>
        <Pressable
          testID={`inbox-dismiss-${item.id}`}
          accessibilityRole="button"
          accessibilityLabel={copy.dismissLabel(item.title)}
          onPress={() => onDismiss(item)}
          hitSlop={th.space.xs}
          style={({ pressed }) => ({
            width: TOUCH,
            minHeight: TOUCH,
            marginTop: th.space.xs,
            marginRight: th.space.xs,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: th.radius.pill,
            backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
          })}
        >
          <Ionicons name="close" size={ICON.sm + 2} color={th.colors.textSubtle} />
        </Pressable>
      </View>
    </ReanimatedSwipeable>
  );
}

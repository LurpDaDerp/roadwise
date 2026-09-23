import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';

import { useDataSource } from '@/data/queries';
import { RewardsOfflineError } from '@/features/rewards/api';
import { goalActiveLine, goalSentence } from '@/features/rewards/copy/common';
import { useEnsureWeek } from '@/features/rewards/useEnsureWeek';
import { useRewards } from '@/features/rewards/useRewards';
import { currentWeekGoal } from '@/features/rewards/goal/weeks';
import { GOAL_HREF } from '@/features/rewards/hub/routes';
import { goalView } from '@/features/rewards/viewModel';
import { Field, FieldText } from '@/features/trips';
import { deviceZone } from '@/lib/deviceZone';
import { dayKey } from '@/lib/time';
import { Banner, Card, Skeleton, Text, useTheme } from '@/ui';

import { homeCopy } from './copy';

const copy = homeCopy.focus;

/** A sentence for the spoken label, which joins its parts with ". " itself. */
const clause = (text: string) => text.replace(/\.$/, '');

/** "2 of 4 driving days" as a ruled bar: passing days of the target, never past full. */
function ProgressBar({ pass, target }: { pass: number; target: number }) {
  const th = useTheme();
  const fraction = target > 0 ? Math.min(1, Math.max(0, pass / target)) : 0;
  return (
    <View
      testID="weekly-focus-bar"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        height: 6,
        borderRadius: 3,
        backgroundColor: th.colors.accentFaint,
        overflow: 'hidden',
      }}
    >
      <View
        testID="weekly-focus-fill"
        style={[{ height: '100%', backgroundColor: th.colors.accent }, { width: `${Math.round(fraction * 100)}%` }]}
      />
    </View>
  );
}

/** The field's body in each state; the goal itself is a ruled row that opens F2. */
function FocusBody() {
  const th = useTheme();
  const router = useRouter();
  const { now } = useDataSource();
  const rewards = useRewards();
  // No goal for this week yet and online: open it (at most once a session and week, never
  // offline, never from the saved copy — `useEnsureWeek`'s own rules).
  useEnsureWeek();

  if (rewards.data) {
    // The one "this week's goal" rule (final review m5), in the device's week as `useEnsureWeek` asks.
    const goal = currentWeekGoal(rewards.data.snapshot, dayKey(new Date(now()), deviceZone()));
    if (goal === null) {
      return (
        <Text variant="subhead" tone="muted" testID="weekly-focus-none">
          {rewards.data.offline ? copy.offline : copy.none}
        </Text>
      );
    }
    const view = goalView(goal);
    const sentence = goalSentence(view.category, view.target);
    const progress = copy.progress(view.pass, view.target);
    // Active: the shared line without its count (the row prints the count itself), never "N more
    // days"; the proration promise only while it can hold, and nothing after a failed day (null).
    const note =
      view.state === 'active'
        ? goalActiveLine({ pass: view.pass, target: view.target, failDays: view.fail, withCount: false })
        : view.remainingText;
    return (
      <View style={{ marginHorizontal: -th.space.lg, marginBottom: -th.space.lg }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.spoken([copy.label, sentence, progress, ...(note === null ? [] : [clause(note)])])}
          onPress={() => router.push(GOAL_HREF)}
          testID="weekly-focus"
          style={({ pressed }) => [
            {
              flexDirection: 'row',
              alignItems: 'center',
              gap: th.space.md,
              paddingHorizontal: th.space.lg,
              paddingTop: th.space.xs,
              paddingBottom: th.space.lg,
            },
            pressed ? { backgroundColor: th.colors.surfaceRaised } : null,
          ]}
        >
          <View style={{ flex: 1, gap: th.space.sm }}>
            <Text variant="body">{sentence}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.md }}>
              <FieldText face="numeral" variant="footnote" tone="muted">
                {progress}
              </FieldText>
              <View style={{ flex: 1 }}>
                <ProgressBar pass={view.pass} target={view.target} />
              </View>
            </View>
            {note === null ? null : (
              <Text variant="footnote" tone="muted" testID="weekly-focus-line">
                {note}
              </Text>
            )}
          </View>
          <Ionicons name="chevron-forward" size={18} color={th.colors.textSubtle} />
        </Pressable>
      </View>
    );
  }

  if (rewards.error) {
    // Offline with nothing saved on this phone is the cause, not a failure.
    if (rewards.error instanceof RewardsOfflineError) {
      return (
        <Text variant="subhead" tone="muted" testID="weekly-focus-none">
          {copy.offline}
        </Text>
      );
    }
    return (
      <Banner
        tone="warning"
        message={copy.error}
        action={{ label: homeCopy.retry, onPress: () => void rewards.refetch() }}
        testID="weekly-focus-error"
      />
    );
  }

  return (
    <View testID="weekly-focus-loading" style={{ gap: th.space.sm }}>
      <Skeleton width="75%" height={20} />
      <Skeleton width="100%" height={12} />
    </View>
  );
}

/**
 * This week's focus in the RECORD section (§7.B B1 item 6; M5 Task 10): the weekly goal as one
 * sentence ("Keep your phone down on 4 driving days"), its passing days of the target with a bar,
 * and a tap to the goal screen. Every number is the server's settled count; nothing is counted on
 * this phone. It reads on mount and on a foreground only (`useRewards`), with no timer.
 */
export function WeeklyFocusField() {
  return (
    <Card testID="weekly-focus-field">
      <Field label={copy.label}>
        <FocusBody />
      </Field>
    </Card>
  );
}

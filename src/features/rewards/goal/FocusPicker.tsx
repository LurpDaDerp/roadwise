import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';

import { useLockout } from '@/features/drive/useLockout';
import { Banner, Button, Text, useTheme } from '@/ui';

import { GOAL_CATEGORY_VALUES, RewardsRpcError, type FocusApplied, type GoalCategory, type RewardsApi } from '../api';
import { CATEGORY_LABEL, FOCUS_APPLIED, goalSentence } from '../copy/common';
import { goalCopy as copy } from '../copy/goal';
import { useSetWeeklyFocus } from '../useRewards';

function Radio({
  label,
  hint,
  checked,
  onPress,
  testID,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space.md,
        minHeight: 44,
        paddingVertical: th.space.sm,
        paddingHorizontal: th.space.sm,
        marginHorizontal: -th.space.sm,
        borderRadius: th.radius.sm,
        backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
      })}
    >
      <Ionicons
        name={checked ? 'radio-button-on' : 'radio-button-off'}
        size={22}
        color={checked ? th.colors.accent : th.colors.borderStrong}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body">{label}</Text>
        <Text variant="footnote" tone="muted">
          {hint}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * "Change focus" (D6): the five goal categories as a radio group in a sheet — a short task, so a
 * sheet rather than a page (§7.0), and the goal stays in view behind it. Save is the sheet's one
 * action; once the server answers, the sheet says where the focus applied (`FOCUS_APPLIED`: this
 * week while no day has counted, else next week — the server decides, never the phone) and the
 * action becomes Done. A refusal is worded in place and the choice is kept, to try again.
 */
export function FocusPicker({
  visible,
  current,
  target,
  currentCounted = false,
  deps = {},
  onClose,
}: {
  visible: boolean;
  /** This week's focus, or null when this week has no goal yet. */
  current: GoalCategory | null;
  /** This week's target in driving days, for each option's sentence. */
  target: number;
  /**
   * This week's goal already has counted days, so a save sets NEXT week's focus — and choosing this
   * week's category again is a real choice (it may undo an earlier, different next-week focus).
   */
  currentCounted?: boolean;
  deps?: { api?: RewardsApi };
  onClose: () => void;
}) {
  const th = useTheme();
  // A native Modal sits above the lockout overlay, so it closes itself while driving.
  const lockedOut = useLockout();
  const open = visible && !lockedOut;
  return (
    <Modal visible={open} transparent animationType={th.reduceMotion ? 'none' : 'slide'} onRequestClose={onClose}>
      {/* Mounted only while open: a dismissed sheet forgets its choice. */}
      {open ? <FocusForm current={current} target={target} currentCounted={currentCounted} deps={deps} onClose={onClose} /> : null}
    </Modal>
  );
}

function FocusForm({
  current,
  target,
  currentCounted,
  deps,
  onClose,
}: {
  current: GoalCategory | null;
  target: number;
  currentCounted: boolean;
  deps: { api?: RewardsApi };
  onClose: () => void;
}) {
  const th = useTheme();
  const setFocus = useSetWeeklyFocus(deps);
  const [selected, setSelected] = useState<GoalCategory | null>(current);
  const [applied, setApplied] = useState<FocusApplied | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    if (selected === null) return;
    setError(null);
    setFocus.mutateAsync(selected).then(
      (answer) => setApplied(answer.applied),
      (e: unknown) => setError(copy.picker.errors[e instanceof RewardsRpcError ? e.code : 'unknown'])
    );
  };

  const choose = (c: GoalCategory) => {
    setSelected(c);
    setApplied(null);
    setError(null);
  };

  return (
    <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: th.colors.scrim }}>
      <View
        style={{
          maxHeight: '88%',
          backgroundColor: th.colors.bgElevated,
          borderTopLeftRadius: th.radius.xl,
          borderTopRightRadius: th.radius.xl,
          padding: th.space.lg,
          paddingBottom: th.space.xl,
          gap: th.space.md,
        }}
      >
        <View style={{ gap: 2 }}>
          <Text variant="title3" accessibilityRole="header">
            {copy.picker.title}
          </Text>
          <Text variant="subhead" tone="muted">
            {copy.picker.instruction}
          </Text>
        </View>

        <ScrollView contentContainerStyle={{ gap: th.space.md, paddingBottom: th.space.sm }}>
          <View accessibilityRole="radiogroup" accessibilityLabel={copy.picker.title} testID="focus-options">
            {GOAL_CATEGORY_VALUES.map((c) => (
              <Radio
                key={c}
                label={CATEGORY_LABEL[c]}
                hint={goalSentence(c, target)}
                checked={selected === c}
                onPress={() => choose(c)}
                testID={`focus-${c}`}
              />
            ))}
          </View>

          {applied !== null ? (
            <Banner tone="success" message={FOCUS_APPLIED[applied]} testID="focus-applied" />
          ) : null}
          {error !== null ? <Banner tone="warning" message={error} testID="focus-error" /> : null}
        </ScrollView>

        {applied !== null ? (
          <Button label={copy.picker.done} onPress={onClose} testID="focus-done" />
        ) : (
          <Button
            label={copy.picker.save}
            onPress={save}
            disabled={selected === null || (selected === current && !currentCounted)}
            loading={setFocus.isPending}
            testID="focus-save"
          />
        )}
        {applied === null ? (
          <Button label={copy.picker.cancel} variant="ghost" size="md" onPress={onClose} testID="focus-cancel" />
        ) : null}
      </View>
    </View>
  );
}

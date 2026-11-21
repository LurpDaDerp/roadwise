import { createContext, useContext, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { Button, IconButton, Screen, Text, useTheme } from '@/ui';

import { onboardingCopy } from './copy';
import type { StepPosition } from './flow';

const PositionContext = createContext<StepPosition | null>(null);

/** The stepper route provides the position, so a step renders its frame without threading it. */
export const StepPositionProvider = PositionContext.Provider;

/** Finishing onboarding after the last step: the buttons wait while it runs, and a failure shows. */
export interface StepFinishState {
  busy: boolean;
  error: string | null;
}

const FinishContext = createContext<StepFinishState>({ busy: false, error: null });

export const StepFinishProvider = FinishContext.Provider;

/**
 * Cancel, from the stepper: `onCancel` asks before it leaves setup, and `busy` is true while the
 * sign-out it leads to runs, when every button on the frame waits.
 */
export interface StepCancelState {
  onCancel: () => void;
  busy: boolean;
}

const CancelContext = createContext<StepCancelState | null>(null);

/** Outside the stepper there is nothing to cancel, and the frame shows no Cancel. */
export const StepCancelProvider = CancelContext.Provider;

export interface StepAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
}

/** Small caps need air between the letters or the word closes up (the licence's field-label step). */
const LABEL_TRACKING = 1.2;
const TARGET = 44;

/**
 * The frame every onboarding step prints on: where the driver is ("Step n of total"), Back when
 * there is somewhere to go back to, Cancel on the right of the same row (inside the stepper), the
 * step's title and body, its own content, and one bottom-anchored primary action with an optional
 * quieter secondary under it.
 *
 * The position reads like a field on the card — a small-caps label over a rule — and the rule is
 * split into one segment per step. The segments are decoration for sighted readers only; the words
 * carry the position for everyone, so meaning never rests on the filled colour.
 *
 * The screen scrolls, so at 200 % text the actions move below the content rather than over it;
 * with room to spare they sit at the bottom, clear of the home indicator.
 */
export function StepFrame({
  title,
  body,
  children,
  primary,
  secondary,
  onBack,
  position,
  testID,
}: {
  title: string;
  body?: string;
  children?: ReactNode;
  primary: StepAction;
  secondary?: StepAction;
  onBack?: () => void;
  /** Overrides the stepper's position; with neither, no position is printed. */
  position?: StepPosition;
  testID?: string;
}) {
  const th = useTheme();
  const fromStepper = useContext(PositionContext);
  const at = position ?? fromStepper;
  const finish = useContext(FinishContext);
  const cancel = useContext(CancelContext);
  // Leaving (finishing setup, or the sign-out Cancel leads to): nothing on the frame starts anything else.
  const leaving = finish.busy || (cancel?.busy ?? false);

  return (
    <Screen scroll testID={testID}>
      <View style={{ flexGrow: 1, gap: th.space.lg }}>
        <View style={{ gap: th.space.sm }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              minHeight: TARGET,
              gap: th.space.md,
            }}
          >
            {onBack ? (
              <IconButton
                icon="chevron-back"
                accessibilityLabel={onboardingCopy.frame.back}
                onPress={onBack}
                variant="surface"
                size={TARGET}
                disabled={cancel?.busy}
              />
            ) : null}
            {at ? (
              <Text
                variant="caption"
                tone="muted"
                style={{
                  // Beside Cancel the position reads from the left; alone it keeps the right edge.
                  marginLeft: cancel ? undefined : 'auto',
                  flexShrink: 1,
                  textTransform: 'uppercase',
                  letterSpacing: LABEL_TRACKING,
                }}
              >
                {onboardingCopy.frame.stepOf(at.index, at.total)}
              </Text>
            ) : null}
            {cancel ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={onboardingCopy.cancel.label}
                accessibilityState={{ disabled: leaving }}
                disabled={leaving}
                onPress={cancel.onCancel}
                hitSlop={8}
                style={({ pressed }) => ({
                  marginLeft: 'auto',
                  minHeight: TARGET,
                  minWidth: TARGET,
                  justifyContent: 'center',
                  opacity: leaving ? 0.5 : pressed ? 0.6 : 1,
                })}
                testID="onboarding-cancel"
              >
                {/* A paper capsule with a hairline (the DashPal setup's Cancel), its 44 pt target around it. */}
                <View
                  style={{
                    minHeight: 36,
                    justifyContent: 'center',
                    paddingHorizontal: th.space.md,
                    borderRadius: th.radius.pill,
                    borderWidth: 1,
                    borderColor: th.colors.border,
                    backgroundColor: th.colors.surface,
                  }}
                >
                  <Text variant="subhead" style={{ fontWeight: '600' }}>
                    {onboardingCopy.cancel.button}
                  </Text>
                </View>
              </Pressable>
            ) : null}
          </View>
          {at ? (
            <View
              testID="onboarding-progress-rule"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={{ flexDirection: 'row', gap: th.space.xs }}
            >
              {Array.from({ length: at.total }, (_, i) => (
                <View
                  key={i}
                  style={{
                    flex: 1,
                    height: 6,
                    alignSelf: 'center',
                    borderRadius: th.radius.pill,
                    backgroundColor: i < at.index ? th.colors.primary : th.colors.border,
                  }}
                />
              ))}
            </View>
          ) : null}
        </View>

        <View style={{ gap: th.space.md, paddingTop: th.space.lg }}>
          <Text variant="title1" accessibilityRole="header">
            {title}
          </Text>
          {body ? <Text variant="body">{body}</Text> : null}
        </View>

        {children}
      </View>

      <View style={{ gap: th.space.sm }}>
        {finish.error ? (
          <Text variant="callout" tone="danger" accessibilityRole="alert" testID="onboarding-finish-error">
            {finish.error}
          </Text>
        ) : null}
        <Button
          label={primary.label}
          onPress={primary.onPress}
          disabled={primary.disabled || leaving}
          loading={primary.loading}
          testID={primary.testID}
        />
        {secondary ? (
          <Button
            label={secondary.label}
            onPress={secondary.onPress}
            disabled={secondary.disabled || leaving}
            loading={secondary.loading}
            testID={secondary.testID}
            variant="ghost"
          />
        ) : null}
      </View>
    </Screen>
  );
}

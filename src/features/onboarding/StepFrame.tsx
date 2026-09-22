import { Ionicons } from '@expo/vector-icons';
import { createContext, useContext, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Screen, Text, useTheme } from '@/ui';

import { onboardingCopy } from './copy';
import type { StepPosition } from './flow';

const PositionContext = createContext<StepPosition | null>(null);

/** The stepper route provides the position, so a step renders its frame without threading it. */
export const StepPositionProvider = PositionContext.Provider;

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
 * there is somewhere to go back to, the step's title and body, its own content, and one
 * bottom-anchored primary action with an optional quieter secondary under it.
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

  return (
    <Screen scroll testID={testID}>
      <View style={{ flexGrow: 1, gap: th.space.lg }}>
        <View style={{ gap: th.space.sm }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              minHeight: TARGET,
            }}
          >
            {onBack ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={onboardingCopy.frame.back}
                onPress={onBack}
                hitSlop={th.space.xs}
                style={({ pressed }) => ({
                  minWidth: TARGET,
                  minHeight: TARGET,
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
            {at ? (
              <Text
                variant="caption"
                tone="muted"
                style={{
                  marginLeft: 'auto',
                  textTransform: 'uppercase',
                  letterSpacing: LABEL_TRACKING,
                }}
              >
                {onboardingCopy.frame.stepOf(at.index, at.total)}
              </Text>
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
                    height: i < at.index ? 3 : StyleSheet.hairlineWidth * 2,
                    alignSelf: 'center',
                    borderRadius: th.radius.pill,
                    backgroundColor: i < at.index ? th.colors.accent : th.colors.borderStrong,
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
        <Button
          label={primary.label}
          onPress={primary.onPress}
          disabled={primary.disabled}
          loading={primary.loading}
          testID={primary.testID}
        />
        {secondary ? (
          <Button
            label={secondary.label}
            onPress={secondary.onPress}
            disabled={secondary.disabled}
            loading={secondary.loading}
            testID={secondary.testID}
            variant="ghost"
          />
        ) : null}
      </View>
    </Screen>
  );
}

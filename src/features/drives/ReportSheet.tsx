import { Ionicons } from '@expo/vector-icons';
import { CAMERA_DISPUTE_AUTO_PER_WEEK } from '@scoring';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Banner, Button, Sheet, Text, useTheme } from '@/ui';

import { eventName, formatClock } from './format';
import type { LocalDriveEvent } from './model';
import { REPORT_LABEL, reportReasons, type ReportReason } from './summary';

const REASON_HELP: Record<ReportReason, string> = {
  hazard: 'Braking for something in the road was the right call. Removed right away, up to 3 times a week.',
  wrong_limit: "If the posted limit didn't match, we'll fix the map and take it off right away, up to 3 times a week.",
  mounted: 'Taps on a mounted phone don’t count. We check what the phone saw.',
  camera_wrong: `If DashPal flagged something that didn’t happen, we’ll take it off right away, up to ${CAMERA_DISPUTE_AUTO_PER_WEEK} times a week, on top of your other reports.`,
  not_driving: 'Someone else was driving. This takes the whole drive off, not just this event.',
};

/**
 * "Report" on one breakdown event: the reasons that fit its type, then send. "I wasn't driving"
 * hands over to the whole-drive confirm instead of sending a dispute.
 */
export function ReportSheet({
  event,
  allowNotDriving,
  onClose,
  onSend,
  onNotDriving,
  onDismiss,
}: {
  event: LocalDriveEvent | null;
  /** "I wasn't driving" only where the whole-drive action is allowed. */
  allowNotDriving: boolean;
  onClose: () => void;
  onSend: (eventId: string, reason: Exclude<ReportReason, 'not_driving'>) => Promise<void>;
  onNotDriving: () => void;
  /** The sheet has left the screen after a close (the moment to open the next sheet). */
  onDismiss?: () => void;
}) {
  const t = useTheme();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  // A different event starts a fresh report (state adjusted during render, not in an effect).
  const [shownFor, setShownFor] = useState(event?.id);
  if (shownFor !== event?.id) {
    setShownFor(event?.id);
    setReason(null);
    setState('idle');
  }

  const reasons = event ? reportReasons(event.type).filter((r) => r !== 'not_driving' || allowNotDriving) : [];

  const send = async () => {
    if (!event || !reason) return;
    if (reason === 'not_driving') {
      onNotDriving();
      return;
    }
    setState('sending');
    try {
      await onSend(event.id, reason);
      setState('sent');
    } catch {
      setState('error');
    }
  };

  return (
    <Sheet visible={event !== null} onClose={onClose} onDismiss={onDismiss} title="Report this event" testID="report-sheet">
      {event ? (
        <View style={{ gap: t.space.md }}>
          <Text variant="subhead" tone="muted">
            {eventName(event.type, event.tier)} at {formatClock(event.startedAt)}
          </Text>
          {state === 'sent' ? (
            <>
              <Banner tone="success" message="Thanks! We'll check it and update your points." testID="report-sent" />
              <Button label="Done" onPress={onClose} variant="secondary" />
            </>
          ) : (
            <>
              <View accessibilityRole="radiogroup" style={{ gap: t.space.sm }}>
                {reasons.map((r) => {
                  const checked = reason === r;
                  return (
                    <Pressable
                      key={r}
                      testID={`reason-${r}`}
                      onPress={() => setReason(r)}
                      accessibilityRole="radio"
                      accessibilityState={{ checked }}
                      accessibilityLabel={REPORT_LABEL[r]}
                      accessibilityHint={REASON_HELP[r]}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        gap: t.space.md,
                        alignItems: 'flex-start',
                        padding: t.space.md,
                        minHeight: t.size.touch,
                        borderRadius: t.radius.lg,
                        borderCurve: 'continuous',
                        borderWidth: checked ? 2 : 1,
                        borderColor: checked ? t.colors.accent : t.colors.border,
                        backgroundColor: pressed ? t.colors.surfaceRaised : t.colors.surface,
                      })}
                    >
                      <Ionicons
                        name={checked ? 'radio-button-on' : 'radio-button-off'}
                        size={t.size.icon}
                        color={checked ? t.colors.accent : t.colors.textMuted}
                      />
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text variant="headline">{REPORT_LABEL[r]}</Text>
                        <Text variant="footnote" tone="muted">
                          {REASON_HELP[r]}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
              {state === 'error' ? (
                <Banner tone="danger" message="Couldn't send that. Check your connection and try again." testID="report-error" />
              ) : null}
              <Button
                label={reason === 'not_driving' ? 'Continue' : 'Send report'}
                onPress={send}
                disabled={reason === null}
                loading={state === 'sending'}
                testID="report-send"
              />
            </>
          )}
        </View>
      ) : null}
    </Sheet>
  );
}

/** The confirm for "Wasn't driving": what happens, and how many uses are left. */
export function NotDrivingSheet({
  visible,
  left,
  points,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  left: number | null;
  points: number | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const t = useTheme();
  const [state, setState] = useState<'idle' | 'sending' | 'error'>('idle');

  // Opening the sheet again starts fresh.
  const [wasVisible, setWasVisible] = useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (visible) setState('idle');
  }

  const confirm = async () => {
    setState('sending');
    try {
      await onConfirm();
      onClose();
    } catch {
      setState('error');
    }
  };

  const pointsLine =
    points === null || points === 0
      ? 'This drive stops counting.'
      : points > 0
        ? `The ${points} points from this drive come off.`
        : `The ${Math.abs(points)} points this drive cost you come back.`;

  return (
    <Sheet visible={visible} onClose={onClose} title="Wasn't driving?" testID="not-driving-sheet">
      <View style={{ gap: t.space.md }}>
        <Text variant="body">
          Use this if someone else was behind the wheel. {pointsLine} Your streak stays as it was.
        </Text>
        <Text variant="subhead" tone="muted" testID="not-driving-left">
          {left === null
            ? 'You can do this 2 times a month.'
            : `You can do this 2 times a month. You have ${left} left.`}
        </Text>
        {state === 'error' ? (
          <Banner tone="danger" message="That didn't go through. It only works on your latest drive, within a day." testID="not-driving-error" />
        ) : null}
        <Button
          label="Yes, I wasn't driving"
          variant="destructive"
          onPress={confirm}
          loading={state === 'sending'}
          disabled={left === 0}
          testID="not-driving-confirm"
        />
        <Button label="Cancel" variant="ghost" onPress={onClose} />
      </View>
    </Sheet>
  );
}

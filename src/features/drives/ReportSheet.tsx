import { Ionicons } from '@expo/vector-icons';
import { CAMERA_DISPUTE_AUTO_PER_WEEK, DISPUTE_AUTO_PER_WEEK } from '@scoring';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Banner, Button, Sheet, Text, useTheme } from '@/ui';

import { recapCopy } from './copy';
import { eventName, formatClock } from './format';
import type { LocalDriveEvent } from './model';
import { availableReasons, REPORT_LABEL, type ReportReason } from './summary';

const REASON_HELP: Record<ReportReason, string> = {
  hazard: `Braking for something in the road was the right call. Removed right away, up to ${DISPUTE_AUTO_PER_WEEK} times a week.`,
  wrong_limit: `If the posted limit didn't match, we'll fix the map and take it off right away, up to ${DISPUTE_AUTO_PER_WEEK} times a week.`,
  mounted: `If your phone sat in a mount and a bump looked like a pickup, we'll take it off right away, up to ${DISPUTE_AUTO_PER_WEEK} times a week.`,
  camera_wrong: `If DashPal flagged something that didn’t happen, we’ll take it off right away, up to ${CAMERA_DISPUTE_AUTO_PER_WEEK} times a week, on top of your other reports.`,
  not_driving: 'Someone else was driving. This takes the whole drive off, not just this event.',
};

/**
 * "Report" on one event of the recap: the reasons that fit its type, then send. "I wasn't driving"
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

  const reasons = event ? availableReasons(event.type, allowNotDriving) : [];

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
              <Banner tone="success" message={recapCopy.report.sent} testID="report-sent" />
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
  onClose,
  onConfirm,
}: {
  visible: boolean;
  left: number | null;
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

  const c = recapCopy.notDriving;
  return (
    <Sheet visible={visible} onClose={onClose} title={c.title} testID="not-driving-sheet">
      <View style={{ gap: t.space.md }}>
        <Text variant="body">{c.body}</Text>
        <Text variant="subhead" tone="muted" testID="not-driving-left">
          {c.left(left)}
        </Text>
        {state === 'error' ? <Banner tone="danger" message={c.error} testID="not-driving-error" /> : null}
        <Button label={c.confirm} variant="destructive" onPress={confirm} loading={state === 'sending'} disabled={left === 0} testID="not-driving-confirm" />
        <Button label={c.cancel} variant="ghost" onPress={onClose} />
      </View>
    </Sheet>
  );
}

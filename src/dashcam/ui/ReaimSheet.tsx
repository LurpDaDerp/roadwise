import { usePreventScreenCapture } from 'expo-screen-capture';
import { useEffect, useMemo, useState } from 'react';
import { AppState, View } from 'react-native';

import { Button, Sheet, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../copy';
import { createReaimFlow, REAIM_RETRY, type ReaimFlow, type ReaimPhase } from '../reaim';
import type { DashcamRuntime } from '../runtime';
import type { AimStatus } from '../setup';
import { useDashcamRuntime } from './useDashcam';
import { AimView } from './wizard/AimView';

const copy = dashpalCopy.screen.reaim;

/** The words under the picture for a phase that is not a picture. */
export function reaimText(p: ReaimPhase): string | null {
  if (p.status === 'offline') return copy.offline;
  if (p.status === 'unsupported') return copy.unsupported;
  if (p.status === 'refused') return copy.refused[p.reason ?? 'camera'];
  return null;
}

/** AimView knows the setup's statuses: anything without a picture reads as refused (no image left). */
const viewStatus = (s: ReaimPhase['status']): AimStatus => (s === 'starting' || s === 'live' || s === 'stalled' ? s : 'refused');

/**
 * Settings › DashPal's camera view (the Recalibrate row, and Home's "Adjust DashPal's camera"): the
 * paired DashPal's live picture, as in setup, to re-aim its camera by, with the refusal in words and
 * Try again where it helps, and Done. Done (or closing the sheet) stops the picture; DashPal then
 * recalibrates and clears its re-aim flag, and with no picture at all Done sends Recalibrate. While it
 * shows the system keeps screenshots, recordings and the app switcher from showing it.
 */
export function ReaimSheet({ visible, onClose }: { visible: boolean; onClose(): void }) {
  const runtime = useDashcamRuntime();
  return (
    <Sheet visible={visible} onClose={onClose} title={copy.title} testID="reaim-sheet">
      {visible && runtime ? <ReaimBody runtime={runtime} onClose={onClose} /> : null}
    </Sheet>
  );
}

function ReaimBody({ runtime, onClose }: { runtime: DashcamRuntime; onClose(): void }) {
  const th = useTheme();
  usePreventScreenCapture('dashpal-reaim');
  const flow: ReaimFlow = useMemo(
    () =>
      createReaimFlow({
        link: runtime.link,
        transport: () => runtime.transport(),
        now: Date.now,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      }),
    [runtime]
  );
  const [phase, setPhase] = useState<ReaimPhase>(() => flow.phase());
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const off = flow.onPhase(setPhase);
    void flow.start();
    const sub = AppState.addEventListener('change', (s) => flow.setAppActive(s === 'active'));
    return () => {
      off();
      sub.remove();
      void flow.close();
    };
  }, [flow]);

  const done = async () => {
    setClosing(true);
    await flow.close();
    onClose();
  };

  const text = reaimText(phase);
  const canRetry = phase.status === 'refused' && phase.reason !== null && REAIM_RETRY.includes(phase.reason);
  const picture = phase.status !== 'offline' && phase.status !== 'unsupported';
  return (
    <View style={{ gap: th.space.md }}>
      {picture ? <AimView flow={flow} status={viewStatus(phase.status)} goodHint={copy.good} /> : null}
      {text !== null ? (
        <Text variant="body" accessibilityLiveRegion="polite" testID={phase.status === 'refused' ? 'reaim-refused' : 'reaim-status'}>
          {text}
        </Text>
      ) : null}
      {picture ? (
        <Text variant="footnote" tone="muted" testID="reaim-privacy">
          {copy.privacy}
        </Text>
      ) : null}
      <Text variant="footnote" tone="muted" testID="reaim-recalibrates">
        {copy.recalibrates}
      </Text>
      {canRetry ? <Button label={copy.tryAgain} variant="secondary" onPress={() => void flow.start()} testID="reaim-retry" /> : null}
      <Button label={copy.done} disabled={closing} onPress={() => void done()} testID="reaim-done" />
    </View>
  );
}

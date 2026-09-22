import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';

import { useDb } from '@/data/queries';
import { useDrive, useDriveHost } from '@/drive/useDrive';
import { readAutoDetectAvailable } from '@/features/drive/DetectionScreen';
import { Card, ListRow, useTheme } from '@/ui';

import { homeCopy } from './copy';

const copy = homeCopy.detection;

/** The detection screen (R16). Cast: typed routes are generated at `expo start`, after this file. */
export const DETECTION_HREF = '/detection' as Href;

export type DetectionLineState = 'on' | 'notRunning' | 'manual' | 'unavailable';

/**
 * What the line may claim (M4 seam N-m2). The toggle is the driver's intent,
 * `host.autoDetectEnabled()`; `status === 'off'` is not that choice — it also means a missing
 * Always location, the server flag, a refused arm, or a host not yet started. So "on" is said only
 * when the driver asked for it AND the host is not off; asked-for but off says it isn't running.
 * With the server flag off, auto-record is unavailable whether or not the driver opted in — never
 * "turned off" by the driver (D2 security M-2). `available` is null until the flag has been read.
 */
export function detectionLineState(
  autoDetect: boolean,
  status: string,
  available: boolean | null
): DetectionLineState {
  // A withdrawn flag is the reason, whatever the opt-in: say that rather than "isn't running"
  // (review U4 m3). Still never "turned off" (D2 M-2).
  if (available === false) return 'unavailable';
  if (autoDetect) return status === 'off' ? 'notRunning' : 'on';
  return 'manual';
}

/** §7.B B1 item 8: "Auto-record is on" / "Manual mode", with the way to the detection screen. */
export function DetectionStatusLine() {
  const th = useTheme();
  const router = useRouter();
  const host = useDriveHost();
  const status = useDrive((s) => s.status);
  // The intent is not in the store (it is not drive state); re-read it whenever Home comes back
  // into focus, which is when the detection screen may have changed it.
  // The flag is re-read on the same beat: a local settings read, off the drive path.
  const db = useDb();
  const [, setFocusTick] = useState(0);
  const [available, setAvailable] = useState<boolean | null>(null);
  useFocusEffect(
    useCallback(() => {
      let live = true;
      setFocusTick((n) => n + 1);
      void readAutoDetectAvailable(db).then((v) => {
        if (live) setAvailable(v);
      });
      return () => {
        live = false;
      };
    }, [db])
  );

  const state = detectionLineState(host.autoDetectEnabled(), status, available);
  const glyph: Record<DetectionLineState, { name: keyof typeof Ionicons.glyphMap; color: string }> = {
    on: { name: 'radio-button-on', color: th.colors.success },
    notRunning: { name: 'alert-circle', color: th.colors.warning },
    manual: { name: 'hand-left-outline', color: th.colors.textMuted },
    unavailable: { name: 'hand-left-outline', color: th.colors.textMuted },
  };
  const title = copy[state];
  const subtitle = state === 'manual' || state === 'unavailable' ? copy.manualHint : undefined;

  return (
    <Card padded={false} testID="detection-status">
      <ListRow
        title={title}
        subtitle={subtitle}
        leading={<Ionicons name={glyph[state].name} size={20} color={glyph[state].color} />}
        onPress={() => router.push(DETECTION_HREF)}
        accessibilityLabel={[title, subtitle, copy.open].filter(Boolean).join(', ')}
        accessibilityHint={copy.openHint}
        testID="detection-status-row"
      />
    </Card>
  );
}

import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';

import type { RecordingMode } from '@/core/permissions';
import { readFlag } from '@/data/config/appConfig';
import { useDb } from '@/data/queries';
import { useDrive, useDriveHost } from '@/drive/useDrive';
import { usePermissionHealth, type PermissionHealthDeps } from '@/features/permissions/usePermissionHealth';
import { Card, ListRow, useTheme } from '@/ui';

import { homeCopy } from './copy';

const copy = homeCopy.detection;

/**
 * The post-onboarding place to turn auto-record on or off (Task 19; it replaced M3's interim
 * detection screen). Cast: typed routes are generated at `expo start`, after this file.
 */
export const AUTO_RECORD_HREF = '/permissions/auto-record' as Href;

export type DetectionLineState = 'on' | 'notRunning' | 'manual' | 'unavailable';

/**
 * What the line may claim (M4 seam N-m2; final review I4 / M3). The toggle is the driver's intent,
 * `host.autoDetectEnabled()`. Whether auto-record is actually running is the host's published
 * `autoDetectArmed` — the result of the one arming predicate — never the engine's status, which
 * says `recording` during a manual drive whatever the arming. B2's `HealthReport.recordingMode`
 * (when the phone has been read) must agree: "on" is said only when the driver asked for it, the
 * host is armed AND the phone's permissions make recording automatic. Asked-for but not all of
 * that says it isn't running. With the server flag off, auto-record is unavailable whether or not
 * the driver opted in — never "turned off" by the driver (D2 security M-2). `available` is null
 * until the flag has been read; `mode` is null until the phone has been.
 */
export function detectionLineState(
  autoDetect: boolean,
  armed: boolean,
  available: boolean | null,
  mode: RecordingMode | null = null
): DetectionLineState {
  // A withdrawn flag is the reason, whatever the opt-in: say that rather than "isn't running"
  // (review U4 m3). Still never "turned off" (D2 M-2).
  if (available === false) return 'unavailable';
  if (autoDetect) return armed && (mode === null || mode === 'automatic') ? 'on' : 'notRunning';
  return 'manual';
}

/**
 * §7.B B1 item 8: "Auto-record is on" / "Manual mode", with the way to the auto-record screen.
 * One line, beside Home's one permission banner: it states the mode, and never repeats the
 * banner's words (the banner names what is wrong; this names the mode). Not shown to an account
 * that does not drive.
 */
export function DetectionStatusLine({ deps }: { deps?: PermissionHealthDeps }) {
  const th = useTheme();
  const router = useRouter();
  const host = useDriveHost();
  const armed = useDrive((s) => s.autoDetectArmed === true);
  const health = usePermissionHealth(deps);
  // The intent is not in the store (it is not drive state); re-read it whenever Home comes back
  // into focus, which is when the auto-record screen may have changed it. The flag is re-read on
  // the same beat: a local settings read, off the drive path.
  const db = useDb();
  const [, setFocusTick] = useState(0);
  const [available, setAvailable] = useState<boolean | null>(null);
  useFocusEffect(
    useCallback(() => {
      let live = true;
      setFocusTick((n) => n + 1);
      void readFlag(db, 'auto_detect').then((v) => {
        if (live) setAvailable(v);
      });
      return () => {
        live = false;
      };
    }, [db])
  );

  if (health.status === 'ready' && !health.context.drives) return null;
  const mode = health.status === 'ready' ? health.report.recordingMode : null;
  const state = detectionLineState(host.autoDetectEnabled(), armed, available, mode);
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
        onPress={() => router.push(AUTO_RECORD_HREF)}
        accessibilityLabel={[title, subtitle, copy.open].filter(Boolean).join(', ')}
        accessibilityHint={copy.openHint}
        testID="detection-status-row"
      />
    </Card>
  );
}

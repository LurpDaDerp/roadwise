import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AUTO_RECORD_INTENT_KEY,
  type PermissionPlatform,
  type PermissionSnapshot,
  type Readiness,
} from '@/core/permissions';
import { useTrips } from '@/data/queries';
import { useSession } from '@/data/supabase/session';
import { useDrive, useDriveHost } from '@/drive/useDrive';
import { completedDrives } from '@/features/permissions/usePermissionHealth';
import { Banner, Card, Skeleton, Text, useTheme } from '@/ui';

import { readGuardianLink, type GuardianLink } from '../api';
import { onboardingCopy } from '../copy';
import { finishOnboarding } from '../finish';
import { isInFlow } from '../flow';
import type { StepProps } from '../stepRegistry';
import { StepFrame } from '../StepFrame';
import { StatusLine, useStepDeps, type LineTone, type PermissionStepDeps } from './permissionKit';

const copy = onboardingCopy.ready;

export type ReadyRowId = 'autoRecord' | 'location' | 'motion' | 'notifications' | 'guardian';

export interface ReadyRow {
  id: ReadyRowId;
  label: string;
  status: string;
  tone: LineTone;
}

export interface ReadyInput {
  drives: boolean;
  platform: PermissionPlatform;
  snapshot: PermissionSnapshot;
  readiness: Readiness;
  /** The `auto_detect` flag. */
  autoDetectAvailable: boolean;
  /** `host.autoDetectEnabled()`: the driver's choice (N-m2). */
  autoDetectOn: boolean;
  /** iOS before the first drive: the wish A9 stored. */
  intent: boolean;
  firstDriveDone: boolean;
  /** Null: no guardian row (the step didn't run). `'failed'`: it couldn't be read. */
  guardian: GuardianLink | 'failed' | null;
}

const row = (id: ReadyRowId, status: string, tone: LineTone): ReadyRow => ({
  id,
  label: copy.rows[id],
  status,
  tone,
});

function autoRecordRow(i: ReadyInput): ReadyRow {
  const s = copy.status;
  if (!i.autoDetectAvailable) return row('autoRecord', s.notAvailable, 'info');
  // "On" only when drive-sense says armed (rev1: I8): never a promise the phone can't keep.
  if (i.readiness.armed === true) return row('autoRecord', s.armed, 'ok');
  if (i.platform === 'ios' && !i.firstDriveDone && i.intent) return row('autoRecord', s.afterFirstDrive, 'info');
  if (i.autoDetectOn) {
    return i.readiness.armed === null
      ? row('autoRecord', s.cantCheck, 'info')
      : row('autoRecord', s.notArmed, 'attention');
  }
  return row('autoRecord', s.off, 'info');
}

function locationRow(snap: PermissionSnapshot): ReadyRow {
  const s = copy.status;
  if (snap.location === 'always' || snap.location === 'foreground') {
    if (snap.precise === false) return row('location', s.approximate, 'attention');
    return row('location', snap.location === 'always' ? s.locationAlways : s.locationWhileUsing, 'ok');
  }
  return snap.location === 'denied' ? row('location', s.off, 'off') : row('location', s.notAllowed, 'attention');
}

function motionRow(snap: PermissionSnapshot): ReadyRow {
  const s = copy.status;
  switch (snap.motion) {
    case 'granted':
      return row('motion', s.allowed, 'ok');
    case 'denied':
      return row('motion', s.off, 'off');
    case 'undetermined':
      return row('motion', s.notAllowed, 'attention');
    case 'unavailable':
      return row('motion', s.notOnPhone, 'info');
    default:
      return row('motion', s.cantCheck, 'info');
  }
}

function notificationsRow(snap: PermissionSnapshot): ReadyRow {
  const s = copy.status;
  switch (snap.notifications) {
    case 'granted':
      return row('notifications', s.allowed, 'ok');
    case 'provisional':
      return row('notifications', s.quiet, 'ok');
    case 'denied':
      return row('notifications', s.off, 'off');
    default:
      return row('notifications', s.notAllowed, 'attention');
  }
}

function guardianRow(g: GuardianLink | 'failed'): ReadyRow {
  const s = copy.status;
  if (g === 'failed') return row('guardian', s.cantCheck, 'info');
  switch (g.status) {
    case 'linked':
      return row('guardian', s.guardianLinked, 'ok');
    case 'pending':
      return row('guardian', s.guardianPending, 'info');
    case 'declined':
      return row('guardian', s.guardianDeclined, 'info');
    case 'expired':
      return row('guardian', s.guardianExpired, 'info');
    default:
      return row('guardian', s.guardianNone, 'info');
  }
}

/**
 * A12's checklist, from what the phone reported just now. A driver gets Auto-record, Location,
 * Motion and Notifications; a non-driver only Notifications. Guardian only when that step ran.
 * No Camera or Family rows (not built until M7 / M6).
 */
export function readyRows(i: ReadyInput): ReadyRow[] {
  const rows = i.drives
    ? [autoRecordRow(i), locationRow(i.snapshot), motionRow(i.snapshot), notificationsRow(i.snapshot)]
    : [notificationsRow(i.snapshot)];
  if (i.guardian !== null) rows.push(guardianRow(i.guardian));
  return rows;
}

/** "Just drive" only when auto-record is armed right now (rev1: I8); no driving tip for a non-driver. */
export function readyTip(drives: boolean, readiness: Readiness | null): string | null {
  if (!drives) return null;
  return readiness?.armed === true ? copy.tipArmed : copy.tipManual;
}

export interface ReadyDeps extends PermissionStepDeps {
  readGuardianLink?: () => Promise<GuardianLink>;
  finish?: typeof finishOnboarding;
}

interface Read {
  snapshot: PermissionSnapshot;
  readiness: Readiness;
  intent: boolean;
  guardian: GuardianLink | 'failed' | null;
}

/**
 * A12 · Ready. A fresh snapshot and `readiness()` on mount (and on retry) — no polling. Every row is
 * a glyph and words. A snapshot that can't be read is an inline error with a retry, never a
 * made-up row; the driver can still go Home. Go to Home (everyone) and Start a drive now
 * (drivers) both finish onboarding (`finishOnboarding`), which replaces the stepper's own exit.
 */
export function ReadyStep({ ctx, onBack, deps = {} }: StepProps & { deps?: ReadyDeps }) {
  const th = useTheme();
  const router = useRouter();
  const { session, refreshProfile } = useSession();
  const { settings, adapter } = useStepDeps(deps);
  const host = useDriveHost();
  useDrive((s) => s.autoDetectArmed === true);
  const trips = useTrips();
  const drives = ctx.drivingStage !== 'non_driver';
  const guardianShown = isInFlow(ctx, 'guardian');
  const readGuardian = deps.readGuardianLink ?? readGuardianLink;

  const [read, setRead] = useState<Read | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [finishing, setFinishing] = useState<'home' | 'drive' | null>(null);
  const [finishFailed, setFinishFailed] = useState(false);
  const running = useRef(false);

  /** One fresh read of everything the rows say; null when the phone can't be read. */
  const fetchRead = useCallback(async (): Promise<Read | null> => {
    try {
      const [snapshot, readiness, intent, guardian] = await Promise.all([
        adapter.snapshot(),
        adapter.readiness().catch((): Readiness => ({ allowed: false, armed: null })),
        settings.get<boolean>(AUTO_RECORD_INTENT_KEY).then((v) => v === true),
        guardianShown ? readGuardian().catch((): 'failed' => 'failed') : Promise.resolve(null),
      ]);
      return { snapshot, readiness, intent, guardian };
    } catch {
      return null;
    }
  }, [adapter, settings, guardianShown, readGuardian]);

  const show = useCallback((next: Read | null) => {
    if (next !== null) setRead(next);
    setReadFailed(next === null);
  }, []);

  useEffect(() => {
    let live = true;
    void fetchRead().then((next) => {
      if (live) show(next);
    });
    return () => {
      live = false;
    };
  }, [fetchRead, show]);

  const load = async () => show(await fetchRead());

  const finish = async (startDrive: boolean) => {
    if (running.current) return;
    running.current = true;
    setFinishing(startDrive ? 'drive' : 'home');
    setFinishFailed(false);
    try {
      await (deps.finish ?? finishOnboarding)(
        { settings, userId: session?.user.id ?? null, router, refreshProfile },
        { startDrive }
      );
    } catch {
      setFinishFailed(true);
    } finally {
      running.current = false;
      setFinishing(null);
    }
  };

  const tripList = trips.data ?? (trips.isError ? [] : undefined);
  const rows =
    read === null
      ? null
      : readyRows({
          drives,
          platform: read.snapshot.platform,
          snapshot: read.snapshot,
          readiness: read.readiness,
          autoDetectAvailable: ctx.features.autoDetect,
          autoDetectOn: host.autoDetectEnabled(),
          intent: read.intent,
          firstDriveDone: tripList !== undefined && completedDrives(tripList) > 0,
          guardian: read.guardian,
        });
  const tip = read === null ? null : readyTip(drives, read.readiness);

  return (
    <StepFrame
      title={copy.title}
      body={copy.body}
      onBack={onBack}
      primary={{
        label: copy.home,
        onPress: () => void finish(false),
        loading: finishing === 'home',
        disabled: finishing !== null,
        testID: 'ready-home',
      }}
      secondary={
        drives
          ? {
              label: copy.startDrive,
              onPress: () => void finish(true),
              loading: finishing === 'drive',
              disabled: finishing !== null,
              testID: 'ready-start-drive',
            }
          : undefined
      }
      testID="ready-step"
    >
      <View style={{ gap: th.space.lg }}>
        {readFailed ? (
          <Banner
            tone="warning"
            message={copy.readFailed}
            action={{ label: copy.retry, onPress: () => void load() }}
            testID="ready-read-error"
          />
        ) : rows === null ? (
          <Card>
            <View accessible accessibilityLabel={copy.title} style={{ gap: th.space.md }}>
              <Skeleton width="100%" height={28} />
              <Skeleton width="100%" height={28} />
              <Skeleton width="100%" height={28} />
            </View>
          </Card>
        ) : (
          <Card variant="license" padded={false} style={{ paddingHorizontal: th.space.lg }}>
            {rows.map((r, i) => (
              <View
                key={r.id}
                testID={`ready-row-${r.id}`}
                accessible
                accessibilityLabel={`${r.label}: ${r.status}`}
                style={{
                  paddingVertical: th.space.md,
                  gap: 2,
                  borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                  borderTopColor: th.colors.border,
                }}
              >
                <Text variant="caption" tone="muted" style={{ textTransform: 'uppercase', letterSpacing: 1.2 }}>
                  {r.label}
                </Text>
                <StatusLine tone={r.tone}>{r.status}</StatusLine>
              </View>
            ))}
          </Card>
        )}
        {tip ? (
          <Text variant="headline" testID="ready-tip">
            {tip}
          </Text>
        ) : null}
        {finishFailed ? (
          <Text variant="callout" tone="danger" accessibilityRole="alert">
            {copy.finishFailed}
          </Text>
        ) : null}
      </View>
    </StepFrame>
  );
}

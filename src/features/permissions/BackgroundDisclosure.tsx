import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, View } from 'react-native';

import {
  AUTO_RECORD_INTENT_KEY,
  DISCLOSURE_AFFIRMED_KEY,
  MANUAL_BY_CHOICE_KEY,
  recordPrompt,
  type PermissionSnapshot,
  type PermissionsAdapter,
} from '@/core/permissions';
import { createSettingsRepo } from '@/data/db';
import type { AppStateLike } from '@/data/foreground';
import { useDb, useTrips } from '@/data/queries';
import { useSession } from '@/data/supabase/session';
import { useDriveHost } from '@/drive/useDrive';
import { DISCLOSURE_TEXT, DISCLOSURE_VERSION } from '@/features/drive/detectionCopy';
import { Banner, Button, Card, Skeleton, Text, useTheme } from '@/ui';

import { permissionsCopy } from './copy';
import {
  completedDrives,
  defaultPermissionsAdapter,
  markSettingsReturn,
  recordDisclosureConsent,
  type RecordDisclosureConsent,
} from './usePermissionHealth';

const copy = permissionsCopy.disclosure;

/** Why the disclosure is showing: onboarding (A6/A9), a post-drive offer, or B2's repair. */
export type DisclosureReason = 'onboarding' | 'first-drive' | 'third-drive' | 'repair';
export const DISCLOSURE_REASONS: readonly DisclosureReason[] = ['onboarding', 'first-drive', 'third-drive', 'repair'];

/** A route's `reason` param. Unknown or missing is B2's repair: the one entry that assumes no drive history. */
export function parseDisclosureReason(raw: string | string[] | undefined): DisclosureReason {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return DISCLOSURE_REASONS.find((r) => r === value) ?? 'repair';
}

/**
 * `always`: granted (consent recorded). `declined`: the OS answered anything else, or the driver
 * tapped Not now — both mark manual by choice. `notAsked`: nothing could be asked — iOS before
 * the first completed drive (design §5.3), or no While Using location yet; nothing is stored.
 */
export type DisclosureResult = 'always' | 'declined' | 'notAsked';

export interface BackgroundDisclosureDeps {
  adapter?: PermissionsAdapter;
  appState?: AppStateLike;
  now?: () => number;
  recordConsent?: RecordDisclosureConsent;
}

/**
 * The app's one prominent disclosure for background location (Google Play; design §5.3), shown
 * before any background request on both platforms. Nothing is asked until the driver taps
 * Continue, which stores the affirmation and makes ONE OS request. When the OS can no longer ask
 * (iOS after "Keep Only While Using"), Continue becomes Open Settings; the grant is picked up on
 * the way back. On `always` the consent `{ background_location, DISCLOSURE_VERSION }` is recorded,
 * manual-by-choice is cleared and, if the driver asked for auto-record, it is turned on. A denial
 * records no consent. Not now asks nothing and marks manual by choice, which nothing nags about.
 *
 * `enableAutoRecord`: the screen the driver came through is about auto-record (the post-drive
 * offers and B2's repair), so Continue also says the driver wants it on.
 */
export function BackgroundDisclosure({
  reason,
  onResult,
  enableAutoRecord = false,
  deps = {},
}: {
  reason: DisclosureReason;
  onResult: (result: DisclosureResult) => void;
  enableAutoRecord?: boolean;
  deps?: BackgroundDisclosureDeps;
}) {
  const th = useTheme();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const host = useDriveHost();
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const trips = useTrips();
  const adapter = deps.adapter ?? defaultPermissionsAdapter();
  const appState = deps.appState ?? AppState;
  const now = deps.now ?? Date.now;

  const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  const awaitingSettings = useRef(false);
  const done = useRef(false);

  // The first drive: post-drive offers exist only after one; otherwise the trip list says.
  const tripList = trips.data ?? (trips.isError ? [] : undefined);
  const firstDriveDone =
    reason === 'first-drive' || reason === 'third-drive' || (tripList !== undefined && completedDrives(tripList) > 0);

  const finish = useCallback(
    (result: DisclosureResult) => {
      if (done.current) return;
      done.current = true;
      onResult(result);
    },
    [onResult]
  );

  const granted = useCallback(async () => {
    if (userId !== null) await recordDisclosureConsent(settings, userId, deps.recordConsent);
    await settings.remove(MANUAL_BY_CHOICE_KEY);
    if ((await settings.get<boolean>(AUTO_RECORD_INTENT_KEY)) === true) await host.setAutoDetect(true);
    finish('always');
  }, [settings, userId, deps.recordConsent, host, finish]);

  /** A read of the phone; null when it can't be read. Never a prompt. */
  const fetchSnapshot = useCallback(async (): Promise<PermissionSnapshot | null> => {
    try {
      return await adapter.snapshot();
    } catch {
      return null;
    }
  }, [adapter]);

  const show = useCallback((s: PermissionSnapshot | null) => {
    if (s !== null) setSnapshot(s);
    setReadFailed(s === null);
  }, []);

  const retryRead = async () => show(await fetchSnapshot());

  useEffect(() => {
    let live = true;
    void fetchSnapshot().then((s) => {
      if (live) show(s);
    });
    // Only a return from the Settings trip this screen started is acted on: Always chosen there
    // is the grant the driver was asked for here.
    const sub = appState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      void fetchSnapshot().then((s) => {
        if (!live) return;
        show(s);
        if (awaitingSettings.current && s?.location === 'always') {
          awaitingSettings.current = false;
          void granted().catch(() => setRequestFailed(true));
        }
      });
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, [fetchSnapshot, show, appState, granted]);

  const loading = snapshot === null || tripList === undefined;
  // Nothing may be asked: iOS before the first completed drive (design §5.3), or no While Using
  // location yet (Always is only ever the step after it). Nothing is offered, and nothing stored.
  const beforeFirstDrive = snapshot?.platform === 'ios' && !firstDriveDone;
  const noForeground =
    snapshot !== null && snapshot.location !== 'foreground' && snapshot.location !== 'always';
  const notYet = beforeFirstDrive || noForeground;
  // The OS cannot show the Always prompt again: only Settings can change it.
  const settingsOnly =
    snapshot !== null && snapshot.location === 'foreground' && !snapshot.locationCanAskAgain;

  const onContinue = async () => {
    if (busy || snapshot === null || notYet) return;
    setBusy(true);
    setRequestFailed(false);
    try {
      await settings.set(DISCLOSURE_AFFIRMED_KEY, { version: DISCLOSURE_VERSION, at: now() });
      if (enableAutoRecord) await settings.set(AUTO_RECORD_INTENT_KEY, true);
      if (settingsOnly) {
        awaitingSettings.current = true;
        await markSettingsReturn(settings, now());
        await adapter.openAppSettings();
        return;
      }
      const access = await adapter.requestLocationAlways({ firstDriveDone });
      await recordPrompt(settings, 'locationAlways', now());
      if (access === 'always') {
        await granted();
      } else {
        await settings.set(MANUAL_BY_CHOICE_KEY, true);
        finish('declined');
      }
    } catch {
      setRequestFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const onNotNow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await settings.set(MANUAL_BY_CHOICE_KEY, true);
      finish('declined');
    } catch {
      setRequestFailed(true);
    } finally {
      setBusy(false);
    }
  };

  let actions;
  if (readFailed) {
    actions = null;
  } else if (loading) {
    actions = null;
  } else if (notYet) {
    actions = <Button label={copy.back} onPress={() => finish('notAsked')} testID="disclosure-back" />;
  } else {
    actions = (
      <>
        <Button
          label={settingsOnly ? copy.openSettings : copy.continue}
          onPress={() => void onContinue()}
          loading={busy}
          accessibilityHint={settingsOnly ? copy.settingsNeeded[snapshot.platform] : copy.continueHint}
          testID="disclosure-continue"
        />
        <Button
          label={copy.notNow}
          variant="ghost"
          onPress={() => void onNotNow()}
          disabled={busy}
          accessibilityHint={copy.notNowHint}
          testID="disclosure-not-now"
        />
      </>
    );
  }

  return (
    <View style={{ flexGrow: 1, gap: th.space.lg }} testID="background-disclosure">
      <Card variant="license">
        <Text variant="title2" accessibilityRole="header">
          {DISCLOSURE_TEXT.heading}
        </Text>
        <Text variant="body">{DISCLOSURE_TEXT.body}</Text>
      </Card>
      {loading && !readFailed ? (
        <Skeleton width="80%" height={20} testID="disclosure-loading" />
      ) : null}
      {notYet ? (
        <Text variant="subhead" tone="muted" testID="disclosure-not-yet">
          {beforeFirstDrive ? copy.notYet : copy.needsForeground}
        </Text>
      ) : null}
      {settingsOnly && !notYet ? (
        <Text variant="headline" testID="disclosure-settings-needed">
          {copy.settingsNeeded[snapshot.platform]}
        </Text>
      ) : null}
      {readFailed ? (
        <Banner
          tone="warning"
          message={permissionsCopy.readError.message}
          action={{ label: permissionsCopy.readError.retry, onPress: () => void retryRead() }}
          testID="disclosure-read-error"
        />
      ) : null}
      {requestFailed ? <Banner tone="danger" message={copy.requestError} testID="disclosure-error" /> : null}
      <View style={{ flexGrow: 1 }} />
      {actions ? <View style={{ gap: th.space.sm }}>{actions}</View> : null}
    </View>
  );
}

/**
 * The auto-record control, shared by A9 (onboarding) and the post-onboarding auto-record screen
 * (Task 19): the toggle "Record drives automatically", why it can't be turned on when it can't,
 * and on Android the battery section.
 *
 * - **On/off is the drive host's.** The toggle reads `host.autoDetectEnabled()` — the driver's
 *   choice, never `DriveState.status === 'off'`, which also means "not armed" (M4 ruling N-m2;
 *   Ruling T8 r1) — and writes through `host.setAutoDetect(enabled)` (rev1: I2). Nothing here
 *   keeps an auto-detect setting of its own.
 * - **It can be turned on** only with Always location and motion granted — except on iOS before
 *   the first completed drive, where Always may not be asked yet (design §5.3): there the toggle
 *   stores `AUTO_RECORD_INTENT_KEY`, and the disclosure offered after the first drive turns
 *   auto-record on once Always is granted. Its line says so.
 * - **The toggle's own line says plainly that it records drives automatically** before any tap,
 *   so the tap is the driver's opt-in (Ruling T9 (2)).
 * - **Android battery:** the maker's guide and "Open battery settings"; the status only when the
 *   phone can report it (drive-sense's `isIgnoringBatteryOptimizations`, T8 (5)).
 * - **This account's disclosure first (Task 19 r1, security I-1), for every caller.** Always is
 *   device-level and survives a handover, so the phone allowing it proves nothing about this
 *   account's consent. Turning auto-record on when the signed-in account has not affirmed the
 *   background-location disclosure opens `BackgroundDisclosure` in place of the panel; its
 *   Continue records the affirmation and the `background_location` consent, then turns
 *   auto-record on. `setAutoDetect(true)` is never called from here without an affirmation. An
 *   auto-record already on but not affirmed says it can't start, with a Review button to the same.
 */
import * as Device from 'expo-device';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import {
  affirmationCovers,
  AUTO_RECORD_INTENT_KEY,
  DISCLOSURE_AFFIRMED_KEY,
  MANUAL_BY_CHOICE_KEY,
  type PermissionPlatform,
  type PermissionSnapshot,
} from '@/core/permissions';
import { useAppConfig, type BatteryGuide, type UseAppConfigDeps } from '@/data/config/appConfig';
import { useTrips } from '@/data/queries';
import { useSession } from '@/data/supabase/session';
import { useDrive, useDriveHost } from '@/drive/useDrive';
import {
  BackgroundDisclosure,
  type DisclosureReason,
  type DisclosureResult,
} from '@/features/permissions/BackgroundDisclosure';
import { guideFor } from '@/features/permissions/oemGuides';
import { completedDrives, markSettingsReturn } from '@/features/permissions/usePermissionHealth';
import { Banner, Button, Skeleton, Text, useTheme } from '@/ui';

import { onboardingCopy } from './copy';
import { FieldLabel } from './steps/BirthDateField';
import { StatusLine, usePhone, useStepDeps, type PermissionStepDeps } from './steps/permissionKit';

const copy = onboardingCopy.autoRecord;

export interface AutoRecordDeps extends PermissionStepDeps {
  /** `expo-device`'s maker name; picks the battery guide. */
  manufacturer?: string | null;
  appConfig?: UseAppConfigDeps;
  /** Why the disclosure shows when it must: onboarding's A9, or the post-onboarding screen. */
  disclosureReason?: DisclosureReason;
}

/** What stands between the driver and auto-record, most basic first. */
export type AutoRecordBlocker = 'location' | 'always' | 'motion';

export type AutoRecordModel =
  | { status: 'loading' }
  | { status: 'error'; retry: () => void }
  | {
      status: 'ready';
      platform: PermissionPlatform;
      /**
       * `host`: the toggle goes through `setAutoDetect`. `intent`: iOS before the first drive, the
       * toggle stores the wish. `blocked`: it can't be turned on here; `blocker` says why.
       */
      mode: 'host' | 'intent' | 'blocked';
      blocker: AutoRecordBlocker | null;
      on: boolean;
      busy: boolean;
      failed: boolean;
      /**
       * The signed-in account has affirmed the background-location disclosure. Without it the host
       * does not arm, and turning on opens the disclosure instead.
       */
      affirmed: boolean;
      /** The disclosure has taken the panel's place (turn on, or Review, without an affirmation). */
      disclosure: {
        reason: DisclosureReason;
        deps: PermissionStepDeps;
        onResult: (result: DisclosureResult) => void;
      } | null;
      /** Opens the disclosure: the Review button when auto-record is on but not affirmed. */
      review: () => void;
      battery: { status: 'exempt' | 'optimized' | null; guide: BatteryGuide } | null;
      setOn: (enabled: boolean) => Promise<boolean>;
      /** A9's Skip: manual by choice, and any stored wish is dropped. */
      skip: () => Promise<void>;
      openBatterySettings: () => Promise<void>;
    };

function blockerOf(s: PermissionSnapshot, needsAlways: boolean): AutoRecordBlocker | null {
  if (s.location !== 'foreground' && s.location !== 'always') return 'location';
  if (needsAlways && s.location !== 'always') return 'always';
  if (needsAlways && s.motion !== 'granted') return 'motion';
  return null;
}

export function useAutoRecord(deps: AutoRecordDeps = {}): AutoRecordModel {
  const { settings, adapter, appState, now } = useStepDeps(deps);
  const phone = usePhone(adapter, appState);
  const host = useDriveHost();
  // Re-render when the host arms or disarms, so the choice read below stays current.
  useDrive((s) => s.autoDetectArmed === true);
  const trips = useTrips();
  const { config } = useAppConfig(deps.appConfig);
  const manufacturer = deps.manufacturer === undefined ? Device.manufacturer : deps.manufacturer;

  const { session } = useSession();
  const uid = session?.user.id ?? null;
  const [intent, setIntent] = useState<boolean | null>(null);
  const [affirmed, setAffirmed] = useState<boolean | null>(null);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const affirmationTicket = useRef(0);

  const readAffirmation = useCallback(async () => {
    const ticket = ++affirmationTicket.current;
    let covered = false;
    try {
      covered = affirmationCovers(await settings.get<unknown>(DISCLOSURE_AFFIRMED_KEY), uid);
    } catch {
      // Unreadable is not affirmed: the disclosure is shown again, never skipped.
      covered = false;
    }
    if (ticket === affirmationTicket.current) setAffirmed(covered);
  }, [settings, uid]);

  useEffect(() => {
    void readAffirmation();
  }, [readAffirmation]);
  const [, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void settings
      .get<boolean>(AUTO_RECORD_INTENT_KEY)
      .then((v) => live && setIntent(v === true))
      .catch(() => live && setIntent(false));
    return () => {
      live = false;
    };
  }, [settings]);

  // A trip list that cannot be read counts as no drive yet: the stricter iOS reading (§5.3).
  const tripList = trips.data ?? (trips.isError ? [] : undefined);
  const snapshot = phone.status === 'ready' ? phone.snapshot : null;
  const firstDriveDone = tripList !== undefined && completedDrives(tripList) > 0;
  const intentMode = snapshot?.platform === 'ios' && !firstDriveDone;

  const setOn = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      setBusy(true);
      setFailed(false);
      try {
        if (intentMode) {
          if (enabled) await settings.set(AUTO_RECORD_INTENT_KEY, true);
          else await settings.remove(AUTO_RECORD_INTENT_KEY);
          setIntent(enabled);
        } else {
          if (enabled && affirmed !== true) {
            // Security I-1: the disclosure first; its Continue turns auto-record on.
            setDisclosureOpen(true);
            return false;
          }
          await host.setAutoDetect(enabled);
          setVersion((v) => v + 1);
        }
        if (enabled) await settings.remove(MANUAL_BY_CHOICE_KEY);
        return true;
      } catch {
        setFailed(true);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [intentMode, settings, host, affirmed]
  );

  const onDisclosureResult = useCallback(() => {
    setDisclosureOpen(false);
    setVersion((v) => v + 1);
    void readAffirmation();
  }, [readAffirmation]);

  const skip = useCallback(async () => {
    await settings.set(MANUAL_BY_CHOICE_KEY, true);
    await settings.remove(AUTO_RECORD_INTENT_KEY);
  }, [settings]);

  const openBatterySettings = useCallback(async () => {
    setFailed(false);
    try {
      await markSettingsReturn(settings, now());
      await adapter.openBatterySettings();
    } catch {
      setFailed(true);
    }
  }, [settings, now, adapter]);

  if (phone.status === 'error') return { status: 'error', retry: () => void phone.reload() };
  if (snapshot === null || tripList === undefined || intent === null || affirmed === null) {
    return { status: 'loading' };
  }

  const blocker = blockerOf(snapshot, !intentMode);
  const mode = blocker !== null ? 'blocked' : intentMode ? 'intent' : 'host';
  const on = intentMode ? intent : host.autoDetectEnabled();
  const battery =
    snapshot.platform === 'android'
      ? {
          status: snapshot.batteryOptimization === 'unknown' ? null : snapshot.batteryOptimization,
          guide: guideFor(manufacturer, config.oem_battery_guides),
        }
      : null;

  return {
    status: 'ready',
    platform: snapshot.platform,
    mode,
    blocker,
    on,
    busy,
    failed,
    affirmed,
    disclosure: disclosureOpen
      ? { reason: deps.disclosureReason ?? 'repair', deps: { adapter, appState, now }, onResult: onDisclosureResult }
      : null,
    review: () => setDisclosureOpen(true),
    battery,
    setOn,
    skip,
    openBatterySettings,
  };
}

export function AutoRecordPanel({ model }: { model: AutoRecordModel }) {
  const th = useTheme();

  if (model.status === 'loading') {
    return (
      <View accessible accessibilityLabel={copy.title} style={{ gap: th.space.md }}>
        <Skeleton width="100%" height={56} />
      </View>
    );
  }
  if (model.status === 'error') {
    return (
      <Banner
        tone="warning"
        message={copy.loadFailed}
        action={{ label: copy.retry, onPress: model.retry }}
        testID="auto-record-read-error"
      />
    );
  }

  if (model.disclosure !== null) {
    return (
      <BackgroundDisclosure
        reason={model.disclosure.reason}
        enableAutoRecord
        deps={model.disclosure.deps}
        onResult={model.disclosure.onResult}
      />
    );
  }

  const { mode, blocker, on, busy, platform, battery } = model;
  // On, but the host cannot arm until this account affirms the disclosure: never "on" (honesty).
  const awaitingOk = mode === 'host' && on && !model.affirmed;
  let line: string;
  if (blocker === 'location') line = copy.needs.location;
  else if (blocker === 'always') line = copy.needs.always[platform];
  else if (blocker === 'motion') line = copy.needs.motion;
  else if (mode === 'intent') line = copy.iosAfterFirstDrive;
  else if (awaitingOk) line = copy.needsOk;
  else line = on ? copy.toggleOn : copy.toggleOff;

  return (
    <View style={{ gap: th.space.xl }}>
      <View
        style={{
          gap: th.space.sm,
          paddingBottom: th.space.md,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: th.colors.border,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.md, minHeight: 44 }}>
          <Text variant="headline" style={{ flex: 1 }}>
            {copy.toggle}
          </Text>
          <Switch
            testID="auto-record-toggle"
            accessibilityRole="switch"
            accessibilityLabel={copy.toggle}
            accessibilityHint={line}
            accessibilityState={{ checked: on, disabled: mode === 'blocked' || busy }}
            value={on}
            disabled={mode === 'blocked' || busy}
            onValueChange={(next) => void model.setOn(next)}
            trackColor={{ true: th.colors.accent, false: th.colors.border }}
          />
        </View>
        {/* Before any tap: what the toggle does, or why it can't (Ruling T9 (2)). */}
        <StatusLine tone={blocker || awaitingOk ? 'attention' : on ? 'ok' : 'info'} testID="auto-record-line">
          {line}
        </StatusLine>
        {awaitingOk ? (
          <View style={{ alignItems: 'flex-start' }}>
            <Button
              label={copy.review}
              variant="secondary"
              size="md"
              onPress={model.review}
              accessibilityHint={copy.reviewHint}
              testID="auto-record-review"
            />
          </View>
        ) : null}
        {model.failed ? (
          <Text variant="callout" tone="danger" accessibilityRole="alert">
            {copy.failed}
          </Text>
        ) : null}
      </View>

      {battery ? (
        <View style={{ gap: th.space.sm }} testID="auto-record-battery-section">
          <FieldLabel>{copy.battery.label}</FieldLabel>
          {battery.status ? (
            <StatusLine tone={battery.status === 'exempt' ? 'ok' : 'attention'}>
              {battery.status === 'exempt' ? copy.battery.exempt : copy.battery.optimized}
            </StatusLine>
          ) : null}
          <View style={{ gap: th.space.xs }}>
            <Text variant="footnote" tone="subtle" accessibilityRole="header">
              {battery.guide.title}
            </Text>
            {battery.guide.steps.map((step, i) => (
              <Text key={i} variant="footnote" tone="muted">
                {`${i + 1}. ${step}`}
              </Text>
            ))}
          </View>
          <View style={{ alignItems: 'flex-start' }}>
            <Button
              label={copy.battery.open}
              variant="secondary"
              size="md"
              onPress={() => void model.openBatterySettings()}
              testID="auto-record-battery"
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

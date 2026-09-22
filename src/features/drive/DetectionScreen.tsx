import DriveSense from '@drive-sense';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, View } from 'react-native';

import { readFlag } from '@/data/config/appConfig';
import type { Db } from '@/data/db';
import { useDb, useTrips } from '@/data/queries';
import { useDriveHost } from '@/drive/useDrive';
import { TripTopBar } from '@/features/trips';
import { Banner, Button, Card, Screen, Skeleton, Text, useTheme } from '@/ui';

import { detectionCopy as copy, DISCLOSURE_TEXT } from './detectionCopy';

/**
 * What the `auto_detect` flag reads as before the server has ever said. The same answer the drive
 * host gives an absent flag (H1: "absent → the flag counts as on"), so this screen never offers
 * what the host would refuse, nor refuses what it would do. H2 must pass the host the same value.
 */
export const AUTO_DETECT_FLAG_FALLBACK = true;

/**
 * Whether the server makes auto-record available (standing rule, D2 security M-2): the flag only
 * ever makes it AVAILABLE. Turning it on is the driver's own opt-in on this screen, whose local
 * default is off; a flag that is off shows auto-record as unavailable, never as turned off.
 */
export const readAutoDetectAvailable = (db: Db): Promise<boolean> =>
  readFlag(db, 'auto_detect', AUTO_DETECT_FLAG_FALLBACK);

/** Android 13 (API 33) is where POST_NOTIFICATIONS became a runtime permission. */
const ANDROID_POST_NOTIFICATIONS_API = 33;

type MotionAnswer = 'granted' | 'denied' | 'unavailable';
type DeviceAccess = { location: 'none' | 'whenInUse' | 'always'; motion: string };

/**
 * Everything the screen asks the phone. Injected so a test can see exactly what was requested and
 * in what order; `expoDetectionDeps` is the device.
 */
export interface DetectionDeps {
  os: string;
  /** `Platform.Version` on Android; ignored elsewhere. */
  androidApi: number;
  /** A read, never a prompt: what drive-sense reports for location and motion. */
  readAccess(): Promise<DeviceAccess>;
  readFlag(db: Db): Promise<boolean>;
  requestMotion(): Promise<MotionAnswer>;
  /** Foreground location, asked only if not already granted (background needs it first). */
  ensureForegroundLocation(): Promise<boolean>;
  requestBackgroundLocation(): Promise<boolean>;
  /** Android 13+: POST_NOTIFICATIONS, so the ongoing "Recording your drive" notice is visible. */
  requestNotifications(): Promise<boolean>;
  openSettings(): Promise<void>;
}

export const expoDetectionDeps: DetectionDeps = {
  os: Platform.OS,
  androidApi: typeof Platform.Version === 'number' ? Platform.Version : 0,
  async readAccess() {
    const s = await DriveSense.getState();
    return { location: s.location, motion: s.motion };
  },
  readFlag: readAutoDetectAvailable,
  requestMotion: () => DriveSense.requestMotionPermission(),
  async ensureForegroundLocation() {
    if ((await Location.getForegroundPermissionsAsync()).granted) return true;
    return (await Location.requestForegroundPermissionsAsync()).granted;
  },
  async requestBackgroundLocation() {
    return (await Location.requestBackgroundPermissionsAsync()).granted;
  },
  async requestNotifications() {
    return (await Notifications.requestPermissionsAsync()).granted;
  },
  openSettings: () => Linking.openSettings(),
};

type Outcome = null | 'denied' | 'unsupported';

/** Auto-record can run only with Always location and granted motion (the host's `shouldArm`). */
const canRun = (access: DeviceAccess | null): boolean =>
  access !== null && access.location === 'always' && access.motion === 'granted';

function Message({ title, body, testID }: { title: string; body: string; testID?: string }) {
  const th = useTheme();
  return (
    <View style={{ gap: th.space.sm }} testID={testID}>
      <Text variant="title3" accessibilityRole="header">
        {title}
      </Text>
      <Text variant="body" tone="muted">
        {body}
      </Text>
    </View>
  );
}

/**
 * The minimal auto-record screen (R16). The prominent disclosure is printed first and nothing is
 * requested until the driver taps *Turn on auto-record*; then motion, location (foreground if
 * needed, then background), and on Android 13+ notifications, in that order, and only then
 * `host.setAutoDetect(true)`. On iPhone it is offered only after the first completed drive and
 * asks for nothing before. Nothing in the app is gated on it (D12): manual Start drive always
 * works. M4 replaces this screen with A9.
 */
export function DetectionScreen({ deps = expoDetectionDeps }: { deps?: DetectionDeps }) {
  const th = useTheme();
  const router = useRouter();
  const db = useDb();
  const host = useDriveHost();
  const trips = useTrips({ limit: 5 });

  const [intent, setIntent] = useState(() => host.autoDetectEnabled());
  const [flag, setFlag] = useState<boolean | null>(null);
  const [access, setAccess] = useState<DeviceAccess | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [notificationsOff, setNotificationsOff] = useState(false);
  const [failed, setFailed] = useState(false);

  /** Reads only — the flag and what drive-sense reports — never a prompt. */
  const read = useCallback(async () => {
    const available = await deps.readFlag(db);
    try {
      return { available, access: await deps.readAccess(), failed: false };
    } catch {
      // No drive-sense (Expo Go, an old build): the state is unknown, which is not "granted".
      return { available, access: null, failed: true };
    }
  }, [deps, db]);

  const apply = useCallback((r: Awaited<ReturnType<typeof read>>) => {
    setFlag(r.available);
    setAccess(r.access);
    setReadFailed(r.failed);
  }, []);
  const refresh = async () => apply(await read());

  useEffect(() => {
    let live = true;
    void read().then((r) => {
      if (live) apply(r);
    });
    return () => {
      live = false;
    };
  }, [read, apply]);

  const turnOn = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    setOutcome(null);
    try {
      const motion = await deps.requestMotion();
      if (motion === 'unavailable') return setOutcome('unsupported');
      if (motion !== 'granted') return setOutcome('denied');
      if (!(await deps.ensureForegroundLocation())) return setOutcome('denied');
      if (!(await deps.requestBackgroundLocation())) return setOutcome('denied');
      if (deps.os === 'android' && deps.androidApi >= ANDROID_POST_NOTIFICATIONS_API) {
        // Not a condition for auto-record: without it the drive is still recorded, only the
        // ongoing notice is hidden — so the screen says that instead of refusing.
        setNotificationsOff(!(await deps.requestNotifications()));
      }
      await host.setAutoDetect(true);
      setIntent(host.autoDetectEnabled());
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await host.setAutoDetect(false);
      setIntent(host.autoDetectEnabled());
      setOutcome(null);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const openSettings = () => void deps.openSettings().catch(() => {});
  const back = router.canGoBack() ? () => router.back() : null;
  // A completed drive: anything the history lists that was not discarded as "not a drive".
  const hasCompletedDrive = (trips.data ?? []).some((t) => t.status !== 'discarded');
  const loading = flag === null || (deps.os === 'ios' && !intent && trips.isPending);

  let body;
  let actions = null;
  if (loading) {
    body = (
      <Card testID="detection-loading">
        <Skeleton width="60%" height={22} />
        <Skeleton width="100%" height={64} />
      </Card>
    );
  } else if (!flag) {
    body = <Message {...copy.notAvailable} testID="detection-not-available" />;
    if (intent) actions = <Button label={copy.turnOff} variant="secondary" onPress={() => void turnOff()} loading={busy} />;
  } else if (intent) {
    const running = canRun(access);
    body = running ? (
      <Message {...copy.on} testID="detection-on" />
    ) : (
      <Message {...copy.blocked} testID="detection-blocked" />
    );
    actions = (
      <>
        {running ? null : <Button label={copy.openSettings} onPress={openSettings} />}
        <Button label={copy.turnOff} variant="secondary" onPress={() => void turnOff()} loading={busy} />
      </>
    );
  } else if (outcome === 'unsupported') {
    body = <Message {...copy.unsupported} testID="detection-unsupported" />;
  } else if (outcome === 'denied') {
    body = <Message {...copy.denied} testID="detection-denied" />;
    actions = <Button label={copy.openSettings} onPress={openSettings} />;
  } else if (deps.os === 'ios' && !hasCompletedDrive) {
    body = <Message {...copy.firstDrive} testID="detection-first-drive" />;
  } else {
    body = (
      <Card variant="license" testID="detection-disclosure">
        <Message title={DISCLOSURE_TEXT.heading} body={DISCLOSURE_TEXT.body} />
      </Card>
    );
    actions = (
      <Button
        label={busy ? copy.requesting : copy.turnOn}
        onPress={() => void turnOn()}
        loading={busy}
        accessibilityHint={copy.turnOnHint}
        testID="detection-turn-on"
      />
    );
  }

  return (
    <Screen scroll testID="detection-screen">
      <TripTopBar title={copy.title} onBack={back} />
      {body}
      {notificationsOff && intent ? <Banner tone="info" message={copy.notificationsNote} /> : null}
      {failed ? (
        <Banner tone="danger" message={copy.readError} testID="detection-error" />
      ) : readFailed && intent ? (
        <Banner
          tone="warning"
          message={copy.readError}
          action={{ label: copy.retry, onPress: () => void refresh() }}
        />
      ) : null}
      <View style={{ flexGrow: 1 }} />
      {actions ? <View style={{ gap: th.space.sm }}>{actions}</View> : null}
    </Screen>
  );
}

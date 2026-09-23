// DMS diagnostics (plan Task 16, R-2): a developer screen for the device pass. It runs the real DMS host
// controller, and so the real privacy gate, against the native module, with a simulated drive.
//
// What it fakes: the drive only (its state, a speed, the mounted mode and the driver role), and the opt-in,
// which M7's consent will own (until then it is a switch that lives as long as this screen). What it reads:
// the stored remote `camera_beta` flag and the signed-in profile's age band, as M7 will, and the app state.
// The camera permission is native's own, read by the controller.
//
// Privacy: the GateToken never leaves the controller (the panel never sees it); the panel keeps no frame
// and no landmark. The live view is states, counts and aggregates only, held in memory while the screen is
// open, and nothing is logged or persisted: the calibration profile goes to an in-memory store, so a
// session here never touches the driver's real one. Leaving the screen disposes the controller (native
// stops).
//
// Reachable only through `app/(app)/dev/dms.tsx`, which a build without the diagnostics flag (and not
// __DEV__) never bundles.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';

import { createDmsController, type DmsController, type DmsGateInputs, type DmsHostSummary, type DmsHudStatus } from '@/core/dms';
import type { FeatureRow } from '@/core/engine/types';
import { readFlag } from '@/data/config/appConfig';
import { useDb } from '@/data/queries/context';
import { useSession } from '@/data/supabase/session';
import { Button, Card, Screen, Text, useTheme } from '@/ui';

import type { DmsVisionApi, NativeStatus } from '../../../modules/dms-vision/src/types';

type AgeBand = DmsGateInputs['ageBand'];

/** The testIDs of the live view, in order: the only values this screen ever shows during a drive. */
const LIVE_FIELDS = ['drive', 'gate', 'camera', 'reason', 'calibration', 'fatigue', 'frames', 'dropped', 'alerts', 'events', 'fps', 'thermal', 'gazeNet'] as const;
type LiveField = (typeof LIVE_FIELDS)[number];

export const dmsDiagCopy = {
  title: 'DMS diagnostics',
  subtitle: 'Development and diagnostics builds only. Nothing here is saved.',
  inputs: 'Gate inputs',
  optIn: (on: boolean) => (on ? 'Opted in (this screen only)' : 'Opt in (this screen only)'),
  startDrive: 'Start simulated drive',
  endDrive: 'End drive',
  speed: (kmh: number) => `${kmh} km/h`,
  askPermission: 'Ask for camera permission',
  live: 'Live',
  summary: 'Last drive (counts only)',
  liveFields: LIVE_FIELDS,
  labels: {
    drive: 'Drive',
    gate: 'Flag · age band',
    camera: 'Camera',
    reason: 'Reason',
    calibration: 'Calibration',
    fatigue: 'Fatigue level',
    frames: 'Frames received',
    dropped: 'Dropped batches · records',
    alerts: 'Alert commands',
    events: 'Engine events',
    fps: 'Native fps (actual / target)',
    thermal: 'Thermal',
    gazeNet: 'Gaze net (available / on)',
  } satisfies Record<LiveField, string>,
  none: '—',
} as const;
const copy = dmsDiagCopy;

const SPEEDS = [0, 15, 30, 60, 100] as const;
const TICK_MS = 1_000;

function ageBandOf(raw: string | null | undefined): AgeBand {
  if (raw === '18_plus') return '18_plus';
  if (raw === null || raw === undefined || raw === 'unknown') return 'unknown';
  return 'other';
}

/** A simulated 1 Hz row: a steady phone on a straight road at `speedKmh` (the only faked sensor value). */
function simulatedRow(ts: number, speedKmh: number, appForeground: boolean): FeatureRow {
  return {
    ts,
    lat: 0,
    lng: 0,
    hAcc: 5,
    speed: speedKmh / 3.6,
    speedAcc: 0.5,
    course: 0,
    alt: 0,
    gnssValid: true,
    aLonMax: 0.05,
    aLonMin: -0.05,
    aLatMax: 0.05,
    aLatMin: -0.05,
    yawRateMax: 0.01,
    jerkMax: 0.1,
    gravityStability: 0.98,
    orientationDelta: 0.01,
    handlingScore: 0.02,
    locked: false,
    screenOn: true,
    appForeground,
  };
}

/** The native status fields the live view shows (no latency or model detail is needed to read a drive). */
interface NativeView {
  fpsActual: number;
  fpsTarget: number;
  thermal: string;
  gazeNetAvailable: boolean;
  gazeNetOn: boolean;
}
function nativeView(s: unknown): NativeView | null {
  if (typeof s !== 'object' || s === null) return null;
  const v = s as Partial<NativeStatus>;
  if (typeof v.fpsActual !== 'number' || typeof v.fpsTarget !== 'number') return null;
  return { fpsActual: v.fpsActual, fpsTarget: v.fpsTarget, thermal: String(v.thermal ?? copy.none), gazeNetAvailable: v.gazeNetAvailable === true, gazeNetOn: v.gazeNetOn === true };
}

interface Tallies {
  alerts: number;
  alertStarts: number;
  events: number;
}

export interface DmsDiagnosticsPanelProps {
  /** The native module (the route hands over the wrapper; tests the fake). */
  native: DmsVisionApi;
  /** The stored remote `camera_beta` flag. */
  cameraBeta: boolean;
  ageBand: AgeBand;
}

/** The screen the route renders: the real flag and age band, then the panel. */
export function DmsDiagnosticsScreen({ native }: { native: DmsVisionApi }) {
  const db = useDb();
  const { profile } = useSession();
  const [cameraBeta, setCameraBeta] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void readFlag(db, 'camera_beta', false).then((v) => {
      if (live) setCameraBeta(v);
    });
    return () => {
      live = false;
    };
  }, [db]);
  // Until the flag is read the gate sees it off: the panel starts closed, as the controller does.
  return <DmsDiagnosticsPanel native={native} cameraBeta={cameraBeta === true} ageBand={ageBandOf(profile?.age_band)} />;
}

export function DmsDiagnosticsPanel({ native, cameraBeta, ageBand }: DmsDiagnosticsPanelProps) {
  const t = useTheme();
  const [optedIn, setOptedIn] = useState(false);
  const [driveActive, setDriveActive] = useState(false);
  const [speedKmh, setSpeedKmh] = useState<number>(60);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [status, setStatus] = useState<DmsHudStatus | null>(null);
  const [counts, setCounts] = useState({ frames: 0, droppedBatches: 0, droppedRecords: 0 });
  const [tallies, setTallies] = useState<Tallies>({ alerts: 0, alertStarts: 0, events: 0 });
  const [nativeStatus, setNativeStatus] = useState<NativeView | null>(null);
  const [summary, setSummary] = useState<DmsHostSummary | null>(null);

  const ctlRef = useRef<DmsController | null>(null);
  const tallyRef = useRef<Tallies>({ alerts: 0, alertStarts: 0, events: 0 });
  // What the 1 Hz tick reads: the drive flag is set by the buttons, the rest follows the state.
  const driveRef = useRef({ active: false, speedKmh: 60, appActive });
  useEffect(() => {
    driveRef.current.speedKmh = speedKmh;
    driveRef.current.appActive = appActive;
  }, [speedKmh, appActive]);

  const refresh = useCallback(() => {
    const ctl = ctlRef.current;
    if (ctl === null) return;
    setStatus(ctl.status());
    setCounts(ctl.diagnostics());
    setTallies({ ...tallyRef.current });
  }, []);

  // One controller for the life of the screen. The callbacks count; they keep no command or event.
  useEffect(() => {
    const ctl = createDmsController({
      native,
      onAlert: (cmd) => {
        tallyRef.current.alerts += 1;
        if (cmd.action === 'start') tallyRef.current.alertStarts += 1;
      },
      onStatus: (s) => setStatus(s),
      onEvent: () => {
        tallyRef.current.events += 1;
      },
      // In memory, and dropped with the screen: a session here never writes the driver's profile.
      profileStore: { load: async () => null, save: async () => {}, clear: async () => {} },
    });
    ctlRef.current = ctl;
    setStatus(ctl.status());
    const sub = native.addListener('status', (s) => setNativeStatus(nativeView(s)));
    const app = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => {
      sub.remove();
      app.remove();
      ctlRef.current = null;
      void ctl.dispose().catch(() => {});
    };
  }, [native]);

  // Every gate input change reaches the controller at once.
  useEffect(() => {
    const ctl = ctlRef.current;
    if (ctl === null) return;
    ctl.setGate({
      optedIn,
      cameraBeta,
      ageBand,
      driveActive,
      mode: 'mounted',
      role: 'driver',
      appActive,
      driverSide: 'left',
      sensitivity: 'normal',
      alerts: 'live',
    });
    refresh();
  }, [optedIn, cameraBeta, ageBand, driveActive, appActive, refresh]);

  // The simulated drive's 1 Hz rows (the policy's heartbeat), and the live view's refresh.
  useEffect(() => {
    const id = setInterval(() => {
      const ctl = ctlRef.current;
      if (ctl === null) return;
      const d = driveRef.current;
      if (d.active) {
        const now = Date.now();
        const local = new Date(now);
        ctl.pushRow(simulatedRow(now, d.speedKmh, d.appActive), { batteryLevel: null, charging: null, localMinutes: local.getHours() * 60 + local.getMinutes() });
      }
      refresh();
    }, TICK_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const startDrive = () => {
    driveRef.current.active = true;
    setSummary(null);
    setDriveActive(true);
  };
  const endDrive = async () => {
    driveRef.current.active = false;
    const ctl = ctlRef.current;
    if (ctl === null) return;
    const s = await ctl.endDrive().catch(() => null);
    setDriveActive(false);
    setSummary(s);
    refresh();
  };
  const askPermission = async () => {
    await native.requestPermission().catch(() => null);
    refresh();
  };

  const value: Record<LiveField, string> = {
    drive: driveActive ? `on · ${copy.speed(speedKmh)}` : 'off',
    gate: `${cameraBeta ? 'on' : 'off'} · ${ageBand}`,
    camera: status?.camera ?? copy.none,
    reason: status?.reason ?? copy.none,
    calibration: status?.calibration ?? copy.none,
    fatigue: status?.fatigueLevel ?? copy.none,
    frames: String(counts.frames),
    dropped: `${counts.droppedBatches} · ${counts.droppedRecords}`,
    alerts: `${tallies.alerts} (${tallies.alertStarts} started)`,
    events: String(tallies.events),
    fps: nativeStatus === null ? copy.none : `${nativeStatus.fpsActual} / ${nativeStatus.fpsTarget}`,
    thermal: nativeStatus?.thermal ?? copy.none,
    gazeNet: nativeStatus === null ? copy.none : `${nativeStatus.gazeNetAvailable ? 'yes' : 'no'} / ${nativeStatus.gazeNetOn ? 'on' : 'off'}`,
  };

  return (
    <Screen scroll>
      <Text variant="title2">{copy.title}</Text>
      <Text tone="muted">{copy.subtitle}</Text>

      <Card>
        <Text variant="headline">{copy.inputs}</Text>
        <View style={[styles.row, { gap: t.space.sm }]}>
          <Button label={copy.optIn(optedIn)} variant={optedIn ? 'primary' : 'secondary'} onPress={() => setOptedIn((v) => !v)} />
          {driveActive ? <Button label={copy.endDrive} variant="destructive" onPress={() => void endDrive()} /> : <Button label={copy.startDrive} onPress={startDrive} />}
          {status?.reason === 'permission' ? <Button label={copy.askPermission} variant="secondary" onPress={() => void askPermission()} /> : null}
        </View>
        <View style={[styles.row, { gap: t.space.sm }]}>
          {SPEEDS.map((kmh) => (
            <Button key={kmh} label={copy.speed(kmh)} size="md" variant={kmh === speedKmh ? 'primary' : 'ghost'} onPress={() => setSpeedKmh(kmh)} />
          ))}
        </View>
      </Card>

      <Card>
        <Text variant="headline">{copy.live}</Text>
        {LIVE_FIELDS.map((f) => (
          <View key={f} style={styles.line}>
            <Text tone="muted">{copy.labels[f]}</Text>
            <Text testID={`dms-${f}`}>{value[f]}</Text>
          </View>
        ))}
      </Card>

      {summary !== null ? (
        <Card testID="dms-summary">
          <Text variant="headline">{copy.summary}</Text>
          {summaryLines(summary).map(([k, v]) => (
            <View key={k} style={styles.line}>
              <Text tone="muted">{k}</Text>
              <Text>{v}</Text>
            </View>
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

/** The summary as counts and aggregates (no timeline, no per-event times). */
function summaryLines(s: DmsHostSummary): [string, string][] {
  const n = (x: number | null) => (x === null ? copy.none : String(Math.round(x * 100) / 100));
  const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  return [
    ['Monitored (s)', n(s.monitoredS.total)],
    ['Tracking coverage', n(s.trackingCoverage)],
    ['Engine events', String(sum(s.events))],
    ['Eyes off road (s)', n(s.eyesOffRoadS)],
    ['Attention score', n(s.attentionScore)],
    ['Camera session', s.cameraSession],
    ['Gaze source', s.gazeSource],
    ['Calibration', s.calibration.state],
    ['Camera starts · retries', `${s.camera.starts} · ${s.camera.retries}${s.camera.gaveUp ? ' (gave up)' : ''}`],
  ];
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 },
  line: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
});

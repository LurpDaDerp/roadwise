// DMS diagnostics (plan Task 16, R-2): a developer screen for the device pass. It runs the real DMS host
// controller, and so the real privacy gate, against the native module, with a simulated drive. The
// controller comes from the host's createDefaultDmsController, which binds the native module inside the host
// (security T14 m-1): this screen never holds the native wrapper.
//
// What it fakes: the drive only (its state, a speed, the mounted mode and the driver role), and the opt-in,
// which M7's consent will own (until then it is a switch that lives as long as this screen). What it reads:
// the stored remote `camera_beta` flag and the signed-in profile's age band, as M7 will, and the app state.
// The camera permission is native's own, read by the controller.
//
// Privacy: the GateToken never leaves the controller (the panel never sees it); the panel keeps no frame
// and no landmark. The live view is states, counts and aggregates only, held in memory while the screen is
// open, and nothing is logged or persisted: the calibration profile goes to an in-memory store, so a
// session here never touches the driver's real one.
//
// The camera runs only while this screen is mounted AND focused (T15 r2, security m-3): the controller is
// created on focus, and on blur (another screen pushed over it, or leaving) the simulated drive ends and
// the controller is disposed, which stops native first. It shares the native module's one owner slot with
// every other default controller (seat m1): while M7's controller holds it, this one stays closed (`busy`)
// and says so.
//
// The shadow comparison (plan Task 16): both gaze sources run as shadow engines on the same frames, so the
// screen shows each source's would-be alerts per hour and their agreement (the median |Δyaw| / |Δpitch| and
// the zone agreement %). Counts and aggregates only; the net column is empty on a build without the net.
//
// Reachable only through `app/(app)/dev/dms.tsx`, which a build without the diagnostics flag (and not
// __DEV__) never bundles.
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';

import {
  createDefaultDmsController,
  createDefaultShadowComparator,
  type DmsShadowComparator,
  type DmsShadowStats,
  type DmsController,
  type DmsDefaultControllerDeps,
  type DmsGateInputs,
  type DmsHostDiagnostics,
  type DmsHostSummary,
  type DmsHudStatus,
} from '@/core/dms';
import type { FeatureRow } from '@/core/engine/types';
import { readFlag } from '@/data/config/appConfig';
import { useDb } from '@/data/queries/context';
import { useSession } from '@/data/supabase/session';
import { Button, Card, Screen, Text, useTheme } from '@/ui';

type AgeBand = DmsGateInputs['ageBand'];

/** The testIDs of the live view, in order: the only values this screen ever shows during a drive. */
const LIVE_FIELDS = [
  'drive',
  'gate',
  'camera',
  'reason',
  'calibration',
  'fatigue',
  'frames',
  'dropped',
  'alerts',
  'events',
  'fps',
  'thermal',
  'gazeNet',
] as const;
type LiveField = (typeof LIVE_FIELDS)[number];

/**
 * The side-by-side comparison (plan Task 16, R-gaze and stage 3): per source the shadow frames, would-be
 * alerts and their rate per hour, then the agreement. Counts and aggregates only; '—' where a build has no net.
 */
const CMP_FIELDS = ['geoFrames', 'geoAlerts', 'netFrames', 'netAlerts', 'agreeYaw', 'agreePitch', 'agreeZone'] as const;
type CmpField = (typeof CMP_FIELDS)[number];

export const dmsDiagCopy = {
  title: 'DMS diagnostics',
  subtitle: 'Development and diagnostics builds only. Nothing here is saved.',
  inputs: 'Gate inputs',
  optIn: (on: boolean) => (on ? 'Opted in (this screen only)' : 'Opt in (this screen only)'),
  startDrive: 'Start simulated drive',
  endDrive: 'End drive',
  speed: (kmh: number) => `${kmh} km/h`,
  askPermission: 'Ask for camera permission',
  busy: "The app's monitoring is active: end the drive first.",
  live: 'Live',
  summary: 'Last drive (counts only)',
  liveFields: LIVE_FIELDS,
  cmp: 'Geometric vs net (shadow, this session)',
  cmpFields: CMP_FIELDS,
  cmpLabels: {
    geoFrames: 'Geometric: frames',
    geoAlerts: 'Geometric: would-be alerts (per hour)',
    netFrames: 'Net: frames',
    netAlerts: 'Net: would-be alerts (per hour)',
    agreeYaw: 'Median |Δyaw| (TRACKING)',
    agreePitch: 'Median |Δpitch| (TRACKING)',
    agreeZone: 'Zone agreement (frames)',
  } satisfies Record<CmpField, string>,
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

interface Tallies {
  alerts: number;
  alertStarts: number;
  events: number;
}

type MakeController = (deps: DmsDefaultControllerDeps) => DmsController;
type MakeComparator = () => DmsShadowComparator;

const EMPTY_CMP: DmsShadowStats = {
  rows: 0,
  geometric: { frames: 0, observedS: 0, alerts: 0, alertsPerHour: null, byKind: {} },
  net: null,
  agreement: { frames: 0, medianAbsDyawDeg: null, medianAbsDpitchDeg: null, zoneFrames: 0, zoneAgreement: null },
};

/** The comparison as display strings: numbers only. */
function cmpValues(s: DmsShadowStats): Record<CmpField, string> {
  const rate = (x: number | null) => (x === null ? copy.none : (Math.round(x * 10) / 10).toFixed(1));
  const deg = (x: number | null) => (x === null ? copy.none : `${x.toFixed(1)}°`);
  const a = s.agreement;
  return {
    geoFrames: String(s.geometric.frames),
    geoAlerts: `${s.geometric.alerts} (${rate(s.geometric.alertsPerHour)}/h)`,
    netFrames: s.net === null ? copy.none : String(s.net.frames),
    netAlerts: s.net === null ? copy.none : `${s.net.alerts} (${rate(s.net.alertsPerHour)}/h)`,
    agreeYaw: deg(a.medianAbsDyawDeg),
    agreePitch: deg(a.medianAbsDpitchDeg),
    agreeZone: a.zoneAgreement === null ? copy.none : `${(a.zoneAgreement * 100).toFixed(1)}% (${a.zoneFrames})`,
  };
}

export interface DmsDiagnosticsPanelProps {
  /** Builds the controller: the host's default (the real native module) unless a test hands in the fake. */
  createController?: MakeController;
  /** Builds the shadow comparator: the host's default unless a test hands in one on the fake. */
  createComparator?: MakeComparator;
  /** The stored remote `camera_beta` flag. */
  cameraBeta: boolean;
  ageBand: AgeBand;
}

/** The screen the route renders: the real flag and age band, then the panel. */
export function DmsDiagnosticsScreen({ createController, createComparator }: { createController?: MakeController; createComparator?: MakeComparator }) {
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
  return (
    <DmsDiagnosticsPanel
      createController={createController}
      createComparator={createComparator}
      cameraBeta={cameraBeta === true}
      ageBand={ageBandOf(profile?.age_band)}
    />
  );
}

export function DmsDiagnosticsPanel({
  createController = createDefaultDmsController,
  createComparator = createDefaultShadowComparator,
  cameraBeta,
  ageBand,
}: DmsDiagnosticsPanelProps) {
  const t = useTheme();
  const [optedIn, setOptedIn] = useState(false);
  const [driveActive, setDriveActive] = useState(false);
  const [speedKmh, setSpeedKmh] = useState<number>(60);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [status, setStatus] = useState<DmsHudStatus | null>(null);
  const [diag, setDiag] = useState<DmsHostDiagnostics>({
    frames: 0,
    droppedBatches: 0,
    droppedRecords: 0,
    ruleSpeedKmh: null,
    native: null,
  });
  const [tallies, setTallies] = useState<Tallies>({
    alerts: 0,
    alertStarts: 0,
    events: 0,
  });
  const [summary, setSummary] = useState<DmsHostSummary | null>(null);
  /** bumped for each new controller (each focus), so its gate is set at once */
  const [session, setSession] = useState(0);

  const [cmp, setCmp] = useState<DmsShadowStats>(EMPTY_CMP);
  const ctlRef = useRef<DmsController | null>(null);
  const cmpRef = useRef<DmsShadowComparator | null>(null);
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
    setDiag(ctl.diagnostics());
    if (cmpRef.current !== null) setCmp(cmpRef.current.stats());
    setTallies({ ...tallyRef.current });
  }, []);

  // One controller per focus. The callbacks count; they keep no command or event.
  useFocusEffect(
    useCallback(() => {
      const ctl = createController({
        onAlert: (cmd) => {
          tallyRef.current.alerts += 1;
          if (cmd.action === 'start') tallyRef.current.alertStarts += 1;
        },
        onStatus: (s) => setStatus(s),
        onEvent: () => {
          tallyRef.current.events += 1;
        },
        // In memory, and dropped with the screen: a session here never writes the driver's profile.
        profileStore: {
          load: async () => null,
          save: async () => {},
          clear: async () => {},
        },
      });
      ctlRef.current = ctl;
      // The shadow engines (one per gaze source) listen to the same session's frames; they never call native.
      const comparator = createComparator();
      cmpRef.current = comparator;
      setStatus(ctl.status());
      setSession((n) => n + 1);
      const app = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
      return () => {
        // Blur or unmount: the simulated drive ends and the camera stops (security m-3).
        app.remove();
        driveRef.current.active = false;
        setDriveActive(false);
        ctlRef.current = null;
        cmpRef.current = null;
        comparator.dispose();
        void ctl.dispose().catch(() => {});
      };
    }, [createController, createComparator]),
  );

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
  }, [optedIn, cameraBeta, ageBand, driveActive, appActive, session, refresh]);

  // The simulated drive's 1 Hz rows (the policy's heartbeat), and the live view's refresh.
  useEffect(() => {
    const id = setInterval(() => {
      const ctl = ctlRef.current;
      if (ctl === null) return;
      const d = driveRef.current;
      if (d.active) {
        const now = Date.now();
        const local = new Date(now);
        const row = simulatedRow(now, d.speedKmh, d.appActive);
        const power = { batteryLevel: null, charging: null, localMinutes: local.getHours() * 60 + local.getMinutes() };
        ctl.pushRow(row, power);
        cmpRef.current?.pushRow(row, power);
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
    cmpRef.current?.endDrive();
    setDriveActive(false);
    setSummary(s);
    refresh();
  };
  const askPermission = async () => {
    await ctlRef.current?.requestPermission().catch(() => null);
    refresh();
  };

  const value: Record<LiveField, string> = {
    drive: driveActive ? `on · ${copy.speed(speedKmh)}` : 'off',
    gate: `${cameraBeta ? 'on' : 'off'} · ${ageBand}`,
    camera: status?.camera ?? copy.none,
    reason: status?.reason ?? copy.none,
    calibration: status?.calibration ?? copy.none,
    fatigue: status?.fatigueLevel ?? copy.none,
    frames: String(diag.frames),
    dropped: `${diag.droppedBatches} · ${diag.droppedRecords}`,
    alerts: `${tallies.alerts} (${tallies.alertStarts} started)`,
    events: String(tallies.events),
    fps: diag.native === null ? copy.none : `${diag.native.fpsActual} / ${diag.native.fpsTarget}`,
    thermal: diag.native?.thermal ?? copy.none,
    gazeNet: diag.native === null ? copy.none : `${diag.native.gazeNetAvailable ? 'yes' : 'no'} / ${diag.native.gazeNetOn ? 'on' : 'off'}`,
  };

  return (
    <Screen scroll>
      <Text variant="title2">{copy.title}</Text>
      <Text tone="muted">{copy.subtitle}</Text>

      <Card>
        <Text variant="headline">{copy.inputs}</Text>
        <View style={[styles.row, { gap: t.space.sm }]}>
          <Button label={copy.optIn(optedIn)} variant={optedIn ? 'primary' : 'secondary'} onPress={() => setOptedIn((v) => !v)} />
          {driveActive ? (
            <Button label={copy.endDrive} variant="destructive" onPress={() => void endDrive()} />
          ) : (
            <Button label={copy.startDrive} onPress={startDrive} />
          )}
          {status?.reason === 'permission' ? <Button label={copy.askPermission} variant="secondary" onPress={() => void askPermission()} /> : null}
        </View>
        {status?.reason === 'busy' ? <Text tone="danger">{copy.busy}</Text> : null}
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

      <Card>
        <Text variant="headline">{copy.cmp}</Text>
        {CMP_FIELDS.map((f) => (
          <View key={f} style={styles.line}>
            <Text tone="muted">{copy.cmpLabels[f]}</Text>
            <Text testID={`dms-cmp-${f}`}>{cmpValues(cmp)[f]}</Text>
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
  line: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
});

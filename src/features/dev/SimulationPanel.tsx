// "Simulate a drive" (U5, R15): a parked, dry-run replay of a fixture drive through the real drive
// host, the real HUD and the real alert player — SR10's parked test.
//
// - The host is `createDriveHost({ persistence: 'none' })` over `createFakeDriveSense()`, with the
//   in-memory corridor client from `fakeLimits.ts`. A dry run keeps no recorder, never finalizes,
//   never calls `limits.startTrip`/`prefetch`, and never writes a setting (H1 and its fix round),
//   so nothing is stored or uploaded. `DriveState.dryRun` is true throughout.
// - It is swapped in for the app's host only under the simulation's own `DriveProvider`, inside a
//   full-screen modal: the app's lockout gate keeps watching the real host, and nothing outside
//   the modal can see the simulated drive.
// - The HUD is drawn as the lockout overlay, which never routes, so the end screen (and its
//   "couldn't save" copy) is never reached by a simulated drive (ruling "Carried from H1").
// - The panel says "nothing was stored" only when SQLite itself saw no write while it ran
//   (`total_changes()` on the app's connection, plus `PRAGMA data_version` for commits made on
//   another connection — the device driver's transactions use their own): the claim is checked,
//   not assumed. Row counts alone would miss an UPDATE or an `INSERT OR REPLACE` (review m1); they
//   are kept only to name the tables in the "changed" message.
// - It cannot start while a real drive is open, and it closes the moment the real host becomes
//   busy or locks out: an RN Modal renders above the lockout overlay (review m2, rev1: I12).
//
// Timers exist only while a simulation runs, which the developer starts on this screen (§3.5).
import * as scoring from '@scoring';
import { createFakeDriveSense } from '@drive-sense';
import { useKeepAwake } from 'expo-keep-awake';
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from 'react';
import { AppState, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { createExpoAlertPorts } from '@/core/alerts/adapters';
import { createAlertPlayer, type AlertPlayer } from '@/core/alerts/player';
import type { AlertLevel } from '@/core/alerts/types';
import { parseTrace, type Trace } from '@/core/replay/trace';
import type { Db } from '@/data/db';
import type { AppStateLike } from '@/data/foreground';
import { useDb } from '@/data/queries/context';
import { DriveContext, DriveProvider } from '@/drive/DriveProvider';
import { createDriveHost, playerInputs, type DriveHost } from '@/drive/host';
import { isBusyStatus } from '@/drive/policy';
import { useDrive } from '@/drive/useDrive';
import { Banner, Button, Card, Text, useTheme } from '@/ui';

import { corridorOf, createFakeLimits } from './fakeLimits';

export const simCopy = {
  title: 'Simulate a drive',
  intro:
    'Replays a recorded drive through the real HUD and alert sounds while parked. Nothing is stored or uploaded.',
  traceLabel: 'Drive',
  speedLabel: 'Playback',
  start: 'Simulate a drive',
  starting: 'Starting…',
  stop: 'Stop simulation',
  stopHint: 'Ends the simulated drive. Nothing is stored.',
  speedName: (x: number) => `${x}× speed`,
  rows: (played: number, total: number) => `${played} of ${total} rows played`,
  cancelled: 'Stopped early.',
  alerts: (a: Record<AlertLevel, number>) =>
    `Alerts sent to the player: ${a[1]} level 1, ${a[2]} level 2, ${a[3]} level 3`,
  unchanged: 'Nothing was stored. Drive history and the speed-limit tile table are as they were.',
  changed: (list: string) =>
    `The database was written while the simulation ran${list ? ` (${list})` : ', with row counts unchanged'}. The simulation writes nothing, so something else in the app did. Run it again with the app otherwise idle.`,
  realDrive: 'Not while a drive is recording.',
  errors: (n: number) => `${n} host error${n === 1 ? '' : 's'} were reported during the run.`,
  failed: (message: string) => `The simulation could not start: ${message}`,
} as const;

export type SimTraceName = 'speeding-corrected' | 'phone-pickup';
export type SimSpeed = 1 | 5;
export const SIM_SPEEDS: readonly SimSpeed[] = [1, 5];

export const SIM_TRACES: readonly { name: SimTraceName; label: string; detail: string }[] = [
  {
    name: 'speeding-corrected',
    label: 'Speeding, then slowing down',
    detail: 'About 45 s at 47 mph on a 35 mph road, then back under the limit. 2½ minutes.',
  },
  {
    name: 'phone-pickup',
    label: 'Phone picked up',
    detail: 'The phone is handled for 8 s at 35 mph. 2½ minutes.',
  },
];

/** Loaded on demand, so the fixtures are parsed only when a developer runs one. */
export function loadSimTrace(name: SimTraceName): Trace {
  // Build-time constants, so a production bundle folds the gate to `false` and Metro drops both
  // requires: the fixtures never ship where the screen cannot open (review m3).
  if (__DEV__ || process.env.EXPO_PUBLIC_DIAGNOSTICS === '1') {
    switch (name) {
      case 'speeding-corrected':
        return parseTrace(require('../../core/__fixtures__/traces/speeding-corrected.json'));
      case 'phone-pickup':
        return parseTrace(require('../../core/__fixtures__/traces/phone-pickup.json'));
    }
  }
  throw new Error('The simulation drives are not in this build');
}

/** Every table a drive could write to, including the tile cache. */
export const SIM_TABLES = [
  'trips',
  'samples',
  'trip_events',
  'settings',
  'sync_queue',
  'speed_limit_tiles',
] as const;
export type TableCounts = Record<(typeof SIM_TABLES)[number], number>;

export async function countTables(db: Db): Promise<TableCounts> {
  const out = {} as TableCounts;
  for (const table of SIM_TABLES) {
    const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
    out[table] = Number(rows[0]?.n ?? 0);
  }
  return out;
}

/** SQLite's own write counters: any INSERT, UPDATE or DELETE moves one of them. */
export interface WriteMark {
  /** `total_changes()` on this connection */
  totalChanges: number;
  /** `PRAGMA data_version`: moves when another connection commits */
  dataVersion: number;
}

export async function writeMark(db: Db): Promise<WriteMark> {
  const t = await db.execute('SELECT total_changes() AS n');
  const v = await db.execute('PRAGMA data_version');
  const row = v.rows[0] ?? {};
  return {
    totalChanges: Number(t.rows[0]?.n ?? 0),
    dataVersion: Number(row.data_version ?? Object.values(row)[0] ?? 0),
  };
}

export interface SimulationOutcome {
  cancelled: boolean;
  rowsPlayed: number;
  total: number;
  alerts: Record<AlertLevel, number>;
  before: TableCounts;
  after: TableCounts;
  /** Judged by `WriteMark`, not by the counts. */
  unchanged: boolean;
  errors: string[];
}

export interface SimulationOptions {
  db: Db;
  trace: Trace;
  speed: SimSpeed;
  /** Late-bound like H2's: the player reads the host it plays for. */
  player: (getHost: () => DriveHost | undefined) => AlertPlayer;
  appState?: AppStateLike;
  platform?: 'ios' | 'android';
}

export interface Simulation {
  host: DriveHost;
  run(): Promise<SimulationOutcome>;
  /**
   * Stop after the row in flight; `run` then ends the drive and resolves. `realDrive: true` (a real
   * drive has started) also silences the simulation's player first, so closing the simulated drive
   * does not release the shared audio session under the real drive's first alert (review r1 n2).
   */
  cancel(opts?: { realDrive?: boolean }): void;
  rowsPlayed(): number;
}

const ROW_MS = 1000;

function refuse(what: string): never {
  throw new Error(`a simulated drive never ${what}`);
}

export function createSimulation(opts: SimulationOptions): Simulation {
  const { db, trace, speed } = opts;
  // Simulated time runs `speed` times faster than the wall clock from the moment `run` starts,
  // so each row's timestamp is "now" when it arrives, and the host's own deadlines (the ending
  // window) scale with the rows.
  let wall0 = Date.now();
  const vnow = () => wall0 + (Date.now() - wall0) * speed;

  const fake = createFakeDriveSense({ platform: opts.platform ?? 'ios', now: vnow });
  fake.setState({ location: 'whenInUse', motion: 'granted' });

  const alerts: Record<AlertLevel, number> = { 1: 0, 2: 0, 3: 0 };
  const errors: string[] = [];
  let host: DriveHost | undefined;
  const inner = opts.player(() => host);
  /** Set when a real drive takes over: the simulation's player then never touches audio again. */
  let yielded = false;
  const player: AlertPlayer = {
    deliver(decision) {
      if (yielded) return Promise.resolve();
      if (!decision.suppressed) alerts[decision.level] += 1;
      return inner.deliver(decision);
    },
    stopCurrent: () => (yielded ? Promise.resolve() : inner.stopCurrent()),
    announce: (key) => (yielded ? Promise.resolve() : inner.announce(key)),
  };

  let ids = 0;
  const created = createDriveHost({
    db,
    source: fake,
    limits: createFakeLimits(corridorOf(trace)),
    player,
    scoring,
    traceWriter: { writeGzip: async () => refuse('writes a trace') },
    hash: { sha256: async () => refuse('hashes a trace') },
    now: vnow,
    tz: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    newId: () => `simulated-${(ids += 1)}`,
    persistence: 'none',
    appState: opts.appState,
    scheduler: {
      setTimeout: (fn, ms) => setTimeout(fn, ms / speed),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    onError: (e, ctx) => errors.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`),
  });
  host = created;

  let cancelled = false;
  let played = 0;
  let pending: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | null = null;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      pending = { timer: setTimeout(resolve, ms), resolve };
    });

  return {
    host: created,
    rowsPlayed: () => played,
    cancel(o) {
      if (o?.realDrive) yielded = true;
      cancelled = true;
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve();
        pending = null;
      }
    },
    async run() {
      const before = await countTables(db);
      const markBefore = await writeMark(db);
      wall0 = Date.now();
      const first = trace.rows[0]?.ts ?? 0;
      fake.loadTrace(trace.rows.map((r) => ({ ...r, ts: wall0 + ROW_MS + (r.ts - first) })));
      await created.start();
      await created.manualStart({
        mode: trace.mode === 'pocket' ? 'pocket' : 'mounted',
        passenger: false,
        evidence: 'tap',
      });
      void created.announce('alert.recording');
      await created.settled();
      while (!cancelled) {
        await wait(ROW_MS / speed);
        pending = null;
        if (cancelled || !fake.step()) break;
        played += 1;
        await created.settled();
      }
      await created.stop({ endOpenTrip: true });
      const markAfter = await writeMark(db);
      const after = await countTables(db);
      return {
        cancelled,
        rowsPlayed: played,
        total: trace.rows.length,
        alerts: { ...alerts },
        before,
        after,
        unchanged:
          markAfter.totalChanges === markBefore.totalChanges &&
          markAfter.dataVersion === markBefore.dataVersion,
        errors: [...errors],
      };
    },
  };
}

/** The real player, as H2 builds it: tones, voice and haptics through the Expo ports. */
async function createRealPlayer(getHost: () => DriveHost | undefined): Promise<AlertPlayer> {
  return createAlertPlayer({
    ...(await createExpoAlertPorts()),
    voiceEnabled: () => true,
    ...playerInputs(getHost),
  });
}

const noSubscription = () => () => {};
const noDrive = () => 'idle';

/**
 * The app's REAL drive, read from the provider this panel sits under (outside the simulation's
 * own provider): 'lockout' while it is locked out, 'busy' while a trip is open, else 'idle'.
 * Outside any provider there is no real drive to protect. One string, so rows do not re-render.
 */
function useRealDrive(): { state: 'idle' | 'busy' | 'lockout'; isBusy: () => boolean } {
  const ctx = useContext(DriveContext);
  const store = ctx?.store;
  const state = useSyncExternalStore(
    store ? store.subscribe : noSubscription,
    store
      ? () => {
          const s = store.getState();
          return s.lockedOut ? 'lockout' : isBusyStatus(s.status) ? 'busy' : 'idle';
        }
      : noDrive
  ) as 'idle' | 'busy' | 'lockout';
  const host = ctx?.host;
  return { state, isBusy: () => host?.isBusy() ?? false };
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running'; sim: Simulation }
  | { kind: 'done'; outcome: SimulationOutcome }
  | { kind: 'failed'; message: string };

export function SimulationPanel({
  Hud,
  createPlayer = createRealPlayer,
}: {
  /** The drive HUD, drawn as the lockout overlay (it never routes). Injected so tests can stub it. */
  Hud: ComponentType;
  createPlayer?: (getHost: () => DriveHost | undefined) => Promise<AlertPlayer>;
}) {
  const th = useTheme();
  const db = useDb();
  const [traceName, setTraceName] = useState<SimTraceName>('speeding-corrected');
  const [speed, setSpeed] = useState<SimSpeed>(1);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const live = useRef(true);
  const running = useRef<Simulation | null>(null);
  const real = useRealDrive();

  // A real drive that opens, or locks out, while a simulation runs ends the simulation at once:
  // two hosts must not drive two players, and the modal must never sit above the real lockout.
  useEffect(() => {
    if (real.state !== 'idle') running.current?.cancel({ realDrive: true });
  }, [real.state]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      running.current?.cancel();
    };
  }, []);

  const start = useCallback(async () => {
    if (real.isBusy()) return;
    setPhase({ kind: 'starting' });
    try {
      let host: DriveHost | undefined;
      const player = await createPlayer(() => host);
      const sim = createSimulation({
        db,
        trace: loadSimTrace(traceName),
        speed,
        player: () => player,
        appState: AppState,
        platform: Platform.OS === 'android' ? 'android' : 'ios',
      });
      host = sim.host;
      running.current = sim;
      const run = sim.run();
      if (live.current) setPhase({ kind: 'running', sim });
      const outcome = await run;
      running.current = null;
      if (live.current) setPhase({ kind: 'done', outcome });
    } catch (e) {
      running.current = null;
      if (live.current) setPhase({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
    }
  }, [createPlayer, db, speed, traceName, real]);

  const busy = phase.kind === 'starting' || phase.kind === 'running';
  const blocked = real.state !== 'idle';

  return (
    <Card testID="simulation-panel">
      <Text variant="title3" accessibilityRole="header">
        {simCopy.title}
      </Text>
      <Text variant="subhead" tone="muted">
        {simCopy.intro}
      </Text>

      <View style={{ gap: th.space.sm }}>
        <Text variant="caption" tone="subtle" style={styles.label}>
          {simCopy.traceLabel}
        </Text>
        {SIM_TRACES.map((t) => (
          <Choice
            key={t.name}
            label={t.label}
            detail={t.detail}
            selected={traceName === t.name}
            disabled={busy}
            onPress={() => setTraceName(t.name)}
          />
        ))}
      </View>

      <View style={{ gap: th.space.sm }}>
        <Text variant="caption" tone="subtle" style={styles.label}>
          {simCopy.speedLabel}
        </Text>
        <View style={{ flexDirection: 'row', gap: th.space.sm }}>
          {SIM_SPEEDS.map((x) => (
            <View key={x} style={{ flex: 1 }}>
              <Choice
                label={`${x}×`}
                accessibilityLabel={simCopy.speedName(x)}
                selected={speed === x}
                disabled={busy}
                onPress={() => setSpeed(x)}
                centered
              />
            </View>
          ))}
        </View>
      </View>

      <Button
        label={phase.kind === 'starting' ? simCopy.starting : simCopy.start}
        onPress={() => void start()}
        loading={phase.kind === 'starting'}
        disabled={busy || blocked}
        accessibilityHint={blocked ? simCopy.realDrive : undefined}
      />
      {blocked ? (
        <Text variant="footnote" tone="muted">
          {simCopy.realDrive}
        </Text>
      ) : null}

      {phase.kind === 'done' ? <OutcomeReport outcome={phase.outcome} /> : null}
      {phase.kind === 'failed' ? <Banner tone="danger" message={simCopy.failed(phase.message)} /> : null}

      {phase.kind === 'running' && !blocked ? (
        <Modal
          visible
          animationType="fade"
          presentationStyle="fullScreen"
          supportedOrientations={['portrait', 'landscape']}
          // Android back ends the simulation; nothing else on the HUD does while "moving".
          onRequestClose={() => phase.sim.cancel()}
        >
          <DriveProvider host={phase.sim.host}>
            <SimulatedDrive Hud={Hud} onStop={() => phase.sim.cancel()} />
          </DriveProvider>
        </Modal>
      ) : null}
    </Card>
  );
}

/**
 * What the modal shows: the HUD while the simulated drive is open, and a Stop control only while
 * the lockout is off (under 5 mph) — at "speed" the HUD's own touch shield is the only thing on
 * top, exactly as on a real drive. The screen is kept awake for the replay, as the lockout gate
 * does for a mounted trip.
 */
function SimulatedDrive({ Hud, onStop }: { Hud: ComponentType; onStop: () => void }) {
  useKeepAwake();
  const insets = useSafeAreaInsets();
  const th = useTheme();
  const s = useDrive((d) => ({ status: d.status, lockedOut: d.lockedOut }));
  const open = s.status === 'candidate' || s.status === 'recording' || s.status === 'ending';
  return (
    <View style={styles.hudGround}>
      {open ? <Hud /> : null}
      {!s.lockedOut ? (
        <View
          style={{
            position: 'absolute',
            top: insets.top + th.space.sm,
            right: insets.right + th.space.lg,
          }}
        >
          <Button
            label={simCopy.stop}
            onPress={onStop}
            variant="secondary"
            size="md"
            accessibilityHint={simCopy.stopHint}
          />
        </View>
      ) : null}
    </View>
  );
}

function OutcomeReport({ outcome }: { outcome: SimulationOutcome }) {
  const th = useTheme();
  const changed = (Object.keys(outcome.before) as (keyof TableCounts)[])
    .filter((t) => outcome.before[t] !== outcome.after[t])
    .map((t) => `${t} ${outcome.before[t]} → ${outcome.after[t]}`)
    .join(', ');
  return (
    <View style={{ gap: th.space.sm }} testID="simulation-outcome">
      <Banner
        tone={outcome.unchanged ? 'success' : 'danger'}
        message={outcome.unchanged ? simCopy.unchanged : simCopy.changed(changed)}
      />
      <Text variant="footnote" tone="muted">
        {simCopy.rows(outcome.rowsPlayed, outcome.total)}
        {outcome.cancelled ? ` ${simCopy.cancelled}` : ''}
      </Text>
      <Text variant="footnote" tone="muted">
        {simCopy.alerts(outcome.alerts)}
      </Text>
      {outcome.errors.length > 0 ? (
        <Text variant="footnote" tone="danger">
          {simCopy.errors(outcome.errors.length)}
        </Text>
      ) : null}
    </View>
  );
}

/** One selectable option: a ruled box that fills with the control colour when chosen. */
function Choice({
  label,
  detail,
  selected,
  disabled,
  onPress,
  centered = false,
  accessibilityLabel,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
  centered?: boolean;
  accessibilityLabel?: string;
}) {
  const th = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (detail ? `${label}, ${detail}` : label)}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        justifyContent: 'center',
        alignItems: centered ? 'center' : 'flex-start',
        gap: 2,
        paddingVertical: th.space.sm,
        paddingHorizontal: th.space.md,
        borderRadius: th.radius.sm,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? th.colors.accent : th.colors.borderStrong,
        backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
        opacity: disabled ? 0.6 : 1,
      })}
    >
      <Text variant="headline" tone={selected ? 'accent' : 'default'}>
        {label}
      </Text>
      {detail ? (
        <Text variant="footnote" tone="muted">
          {detail}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: { textTransform: 'uppercase', letterSpacing: 1.2 },
  hudGround: { flex: 1, backgroundColor: '#000000' },
});

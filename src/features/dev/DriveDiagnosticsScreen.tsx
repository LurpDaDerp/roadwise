// Drive diagnostics (U5, R15): a developer screen for the device pass. It reads — it never
// commands capture, arming or permissions — and it holds no timer: everything is read once when it
// opens and again on Refresh, and the live battery level comes from expo-battery's listener hooks
// while the screen is mounted (§3.5).
//
// Reachable only when `__DEV__ || env.diagnostics` (`EXPO_PUBLIC_DIAGNOSTICS=1`, which eas.json
// sets for the development and preview profiles only). A store build is sent home by the route.
//
// Rows come from SQLite (`samples`), not from a native `row` listener: a JS listener attached here
// would receive the rows native buffered for the drive host (README §3, "Buffering") and would
// count as the watchdog's liveness signal (§6.2), so opening this screen could lose rows or keep
// an orphaned capture alive. Samples exist only for a drive still recording or not yet saved.
import DriveSense, { type DriveSenseApi, type DriveSenseState, type ExitInfo, type FeatureRow } from '@drive-sense';
import { Ionicons } from '@expo/vector-icons';
import * as Battery from 'expo-battery';
import { Redirect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { AlertPlayer } from '@/core/alerts/player';
import { asNumber, asText } from '@/data/db/row';
import { createSettingsRepo, type Db } from '@/data/db';
import { useDb } from '@/data/queries/context';
import type { DriveHost } from '@/drive/host';
import { mpsToMph } from '@/lib/units';
import { Banner, Button, Card, fontFamilies, Screen, Text, useTheme } from '@/ui';

import { formatLevel, readDriveBattery, type BatteryReading, type DriveBatteryRecord } from './battery';
import { diagnosticsEnabled } from './flags';
import { SelfTestPanel } from './SelfTestPanel';
import { SimulationPanel } from './SimulationPanel';

export const diagCopy = {
  title: 'Drive diagnostics',
  subtitle: 'Development and preview builds only.',
  back: 'Back',
  refresh: 'Refresh',
  sensing: 'Drive sensing',
  permissions: 'Permissions',
  lastExit: 'Last exit',
  rows: 'Last 10 stored rows',
  battery: 'Battery',
  unavailable: (message: string) => `Drive sensing could not be read: ${message}`,
  armed: 'Armed',
  notArmed: 'Not armed',
  capture: 'Capture',
  notCapturing: 'Not capturing',
  capturing: (mode: string | null, rate: string | null) => `${mode ?? 'unknown mode'} · ${rate ?? 'unknown rate'}`,
  captureStarted: 'Capture started',
  lastRow: 'Last row',
  captureWasOpen: 'Capture open at last exit',
  lockSignal: 'Lock signal',
  platform: 'Platform',
  location: 'Location',
  motion: 'Motion',
  batteryOptimisation: 'Battery optimisation',
  exempt: 'Exempt',
  restricted: 'Restricted: Doze may stop auto-record',
  noRestriction: 'None on iOS',
  notRead: 'Not read',
  yes: 'Yes',
  no: 'No',
  never: 'Never',
  reason: 'Reason',
  when: 'When',
  whileCapturing: 'While capturing',
  noExit: (platform: string | null) =>
    platform === 'ios' ? 'No exit recorded. iOS does not report exit reasons.' : 'No exit recorded.',
  noRows: 'No rows are stored. Rows are kept only while a drive records, and are cleared once it is saved.',
  rowsOf: (id: string) => `Trip ${id}`,
  noFix: 'no fix',
  now: 'Now',
  powerSaving: 'Power saving',
  on: 'On',
  off: 'Off',
  charging: 'Charging',
  chargingStates: ['Unknown', 'On battery', 'Charging', 'Full'] as const,
  lastDrive: 'Last drive',
  atStart: 'At recording start',
  atEnd: 'At drive end',
  notSeenStart: 'Not seen: diagnostics began mid-drive',
  stillOpen: 'Not seen: the drive is open, or the app did not see it close',
  withPowerSaving: 'power saving on',
  drain: (pctPerHour: string, minutes: number) => `${pctPerHour} % per hour over ${minutes} min`,
  noDrive: 'No drive recorded with diagnostics on yet.',
} as const;

/** The route guard: a developer build, or a build made with the diagnostics flag (`./flags`). */
export { diagnosticsEnabled };


type DiagSource = Pick<
  DriveSenseApi,
  'getState' | 'getLastExitInfo' | 'isIgnoringBatteryOptimizations' | 'selfTest'
>;

export interface DriveDiagnosticsProps {
  /** The drive HUD for the simulation (the route passes U2's, drawn as the lockout overlay). */
  Hud: ComponentType;
  source?: DiagSource;
  createPlayer?: (getHost: () => DriveHost | undefined) => Promise<AlertPlayer>;
}

export function DriveDiagnosticsRoute(props: DriveDiagnosticsProps) {
  if (!diagnosticsEnabled()) return <Redirect href="/" />;
  return <DriveDiagnosticsScreen {...props} />;
}

interface StoredRow {
  clientTripId: string;
  ts: number;
  row: Partial<FeatureRow>;
}

async function lastStoredRows(db: Db): Promise<StoredRow[]> {
  const { rows } = await db.execute(
    'SELECT client_trip_id, ts, row_json FROM samples ORDER BY ts DESC LIMIT 10'
  );
  return rows.map((r) => {
    let row: Partial<FeatureRow> = {};
    try {
      row = JSON.parse(asText(r, 'row_json')) as Partial<FeatureRow>;
    } catch {
      // An unreadable row still shows its time.
    }
    return { clientTripId: asText(r, 'client_trip_id'), ts: asNumber(r, 'ts'), row };
  });
}

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

async function attempt<T>(p: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await p() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

interface Snapshot {
  state: Read<DriveSenseState>;
  exit: Read<ExitInfo | null>;
  ignoring: Read<boolean>;
  rows: Read<StoredRow[]>;
  battery: Read<DriveBatteryRecord | null>;
}

const when = (ts: number | null | undefined) => (ts == null ? diagCopy.never : new Date(ts).toLocaleString());

export function DriveDiagnosticsScreen({ Hud, source = DriveSense, createPlayer }: DriveDiagnosticsProps) {
  const th = useTheme();
  const db = useDb();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const live = useRef(true);

  const load = useCallback(async () => {
    const [state, exit, ignoring, rows, battery] = await Promise.all([
      attempt(() => source.getState()),
      attempt(() => source.getLastExitInfo()),
      attempt(() => source.isIgnoringBatteryOptimizations()),
      attempt(() => lastStoredRows(db)),
      attempt(() => readDriveBattery(createSettingsRepo(db))),
    ]);
    if (live.current) setSnap({ state, exit, ignoring, rows, battery });
  }, [db, source]);

  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [load]);

  const platform = snap?.state.ok ? snap.state.value.platform : null;

  return (
    <Screen scroll>
      <Header onRefresh={() => void load()} />

      {snap && !snap.state.ok ? <Banner tone="danger" message={diagCopy.unavailable(snap.state.error)} /> : null}

      <Section title={diagCopy.sensing}>
        {snap?.state.ok ? <SensingLines s={snap.state.value} /> : null}
      </Section>

      <Section title={diagCopy.permissions}>
        {snap?.state.ok ? (
          <>
            <Line label={diagCopy.location} value={snap.state.value.location} first />
            <Line label={diagCopy.motion} value={snap.state.value.motion} />
            <Line
              label={diagCopy.batteryOptimisation}
              value={
                platform === 'ios'
                  ? diagCopy.noRestriction
                  : snap.ignoring.ok
                    ? snap.ignoring.value
                      ? diagCopy.exempt
                      : diagCopy.restricted
                    : diagCopy.notRead
              }
            />
          </>
        ) : null}
      </Section>

      <Section title={diagCopy.lastExit}>
        {snap ? <ExitLines exit={snap.exit} platform={platform} /> : null}
      </Section>

      <Section title={diagCopy.rows}>{snap ? <RowList rows={snap.rows} /> : null}</Section>

      <Section title={diagCopy.battery}>
        <BatteryNow />
        {snap ? <LastDriveBattery record={snap.battery} /> : null}
      </Section>

      <SelfTestPanel source={source} />
      <SimulationPanel Hud={Hud} {...(createPlayer ? { createPlayer } : {})} />
      <View style={{ height: th.space.lg }} />
    </Screen>
  );
}

function Header({ onRefresh }: { onRefresh: () => void }) {
  const th = useTheme();
  const router = useRouter();
  const back = router.canGoBack() ? () => router.back() : null;
  return (
    <View style={{ gap: th.space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm, minHeight: 44 }}>
        {back ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={diagCopy.back}
            onPress={back}
            hitSlop={th.space.sm}
            style={({ pressed }) => ({
              minWidth: 44,
              minHeight: 44,
              alignItems: 'center',
              justifyContent: 'center',
              marginLeft: -th.space.sm,
              borderRadius: th.radius.pill,
              backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
            })}
          >
            <Ionicons name="chevron-back" size={26} color={th.colors.accent} />
          </Pressable>
        ) : null}
        <Text variant="title1" accessibilityRole="header" style={{ flex: 1 }}>
          {diagCopy.title}
        </Text>
        <Button label={diagCopy.refresh} onPress={onRefresh} variant="ghost" size="md" />
      </View>
      <Text variant="footnote" tone="muted">
        {diagCopy.subtitle}
      </Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <Text variant="title3" accessibilityRole="header">
        {title}
      </Text>
      <View>{children}</View>
    </Card>
  );
}

/** One ruled line: the name on the left, the value in the numerals face on the right. */
function Line({
  label,
  value,
  first = false,
  tone = 'default',
}: {
  label: string;
  value: string;
  first?: boolean;
  tone?: 'default' | 'danger';
}) {
  const th = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={{
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: th.space.md,
        minHeight: 44,
        paddingVertical: th.space.sm,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: th.colors.divider,
      }}
    >
      <Text variant="subhead" tone="muted" style={{ flex: 1 }}>
        {label}
      </Text>
      <Text
        variant="subhead"
        tone={tone}
        style={{ fontFamily: fontFamilies.numerals, flexShrink: 1, textAlign: 'right' }}
      >
        {value}
      </Text>
    </View>
  );
}

function SensingLines({ s }: { s: DriveSenseState }) {
  return (
    <>
      <Line label={diagCopy.platform} value={s.platform} first />
      <Line label="Arming" value={s.armed ? diagCopy.armed : diagCopy.notArmed} />
      <Line label={diagCopy.capture} value={s.capturing ? diagCopy.capturing(s.mode, s.rate) : diagCopy.notCapturing} />
      <Line label={diagCopy.captureStarted} value={when(s.captureStartedAt)} />
      <Line label={diagCopy.lastRow} value={when(s.lastRowTs)} />
      <Line label={diagCopy.captureWasOpen} value={s.captureWasOpen ? diagCopy.yes : diagCopy.no} />
      <Line label={diagCopy.lockSignal} value={s.lockSignal} />
    </>
  );
}

function ExitLines({ exit, platform }: { exit: Read<ExitInfo | null>; platform: string | null }) {
  if (!exit.ok) return <Line label={diagCopy.reason} value={exit.error} tone="danger" first />;
  if (!exit.value) {
    return (
      <Text variant="subhead" tone="muted">
        {diagCopy.noExit(platform)}
      </Text>
    );
  }
  return (
    <>
      <Line label={diagCopy.reason} value={exit.value.reason} first />
      <Line label={diagCopy.when} value={when(exit.value.ts)} />
      <Line label={diagCopy.whileCapturing} value={exit.value.whileCapturing ? diagCopy.yes : diagCopy.no} />
    </>
  );
}

function RowList({ rows }: { rows: Read<StoredRow[]> }) {
  const th = useTheme();
  if (!rows.ok) return <Line label={diagCopy.rows} value={rows.error} tone="danger" first />;
  if (rows.value.length === 0) {
    return (
      <Text variant="subhead" tone="muted">
        {diagCopy.noRows}
      </Text>
    );
  }
  const trips = [...new Set(rows.value.map((r) => r.clientTripId))];
  return (
    <View style={{ gap: th.space.xs }}>
      <Text variant="caption" tone="subtle">
        {trips.map(diagCopy.rowsOf).join(', ')}
      </Text>
      {rows.value.map((r, i) => {
        const { row } = r;
        const speed =
          row.gnssValid && typeof row.speed === 'number' && row.speed >= 0
            ? `${mpsToMph(row.speed).toFixed(1)} mph`
            : diagCopy.noFix;
        const detail = [
          typeof row.hAcc === 'number' && row.hAcc >= 0 ? `±${Math.round(row.hAcc)} m` : null,
          typeof row.course === 'number' && row.course >= 0 ? `${Math.round(row.course)}°` : null,
          typeof row.handlingScore === 'number' ? `handling ${row.handlingScore.toFixed(2)}` : null,
          row.locked ? 'locked' : row.screenOn ? 'screen on' : 'screen off',
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <View
            key={`${r.clientTripId}:${r.ts}`}
            testID="diag-row"
            accessible
            style={{
              paddingVertical: th.space.xs,
              borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
              borderTopColor: th.colors.divider,
            }}
          >
            <Text variant="footnote" style={{ fontFamily: fontFamilies.numerals }}>
              {`${new Date(r.ts).toLocaleTimeString()}  ${speed}`}
            </Text>
            <Text variant="caption" tone="muted" style={{ fontFamily: fontFamilies.numerals }}>
              {detail}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** Live while the screen is open: expo-battery's hooks subscribe on mount and unsubscribe on unmount. */
function BatteryNow() {
  const level = Battery.useBatteryLevel();
  const lowPower = Battery.useLowPowerMode();
  const state = Battery.useBatteryState();
  return (
    <>
      <Line label={diagCopy.now} value={formatLevel(level >= 0 ? level : null)} first />
      <Line label={diagCopy.powerSaving} value={lowPower ? diagCopy.on : diagCopy.off} />
      <Line label={diagCopy.charging} value={(diagCopy.chargingStates as readonly string[])[state] ?? diagCopy.chargingStates[0]} />
    </>
  );
}

function reading(r: BatteryReading | null): { value: string; at: string } | null {
  if (!r) return null;
  const level = formatLevel(r.level);
  return {
    value: r.lowPower ? `${level} · ${diagCopy.withPowerSaving}` : level,
    at: when(r.at),
  };
}

function LastDriveBattery({ record }: { record: Read<DriveBatteryRecord | null> }) {
  const th = useTheme();
  if (!record.ok) return <Line label={diagCopy.lastDrive} value={record.error} tone="danger" />;
  if (!record.value) {
    return (
      <Text variant="subhead" tone="muted" style={{ paddingTop: th.space.sm }}>
        {diagCopy.noDrive}
      </Text>
    );
  }
  const { start, end } = record.value;
  const s = reading(start);
  const e = reading(end);
  const minutes = start && end ? Math.round((end.at - start.at) / 60_000) : 0;
  const drain =
    start?.level != null && end?.level != null && minutes > 0
      ? diagCopy.drain((((start.level - end.level) * 100) / (minutes / 60)).toFixed(1), minutes)
      : null;
  return (
    <View style={{ paddingTop: th.space.md }}>
      <Text variant="headline">{diagCopy.lastDrive}</Text>
      <Line label={diagCopy.atStart} value={s?.value ?? diagCopy.notSeenStart} first />
      {s ? <Text variant="caption" tone="muted">{s.at}</Text> : null}
      <Line label={diagCopy.atEnd} value={e?.value ?? diagCopy.stillOpen} />
      {e ? <Text variant="caption" tone="muted">{e.at}</Text> : null}
      {drain ? (
        <Text variant="footnote" style={{ paddingTop: th.space.sm }}>
          {drain}
        </Text>
      ) : null}
    </View>
  );
}

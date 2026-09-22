/**
 * C1 — the pre-drive sheet, and the route logic in front of it (§7.C C1; M3 brief U3).
 *
 * `DriveStartScreen` decides what a tap on Drive means before any sheet shows:
 * 1. A drive already under way (auto-detected, or started elsewhere) → Home, where the in-progress
 *    banner is. Nothing is asked, started or announced (rev1: m).
 * 2. Location: asked once when undetermined; denied → the blocking explainer with Open Settings,
 *    re-read (never re-asked) when the app comes back (§7.0).
 * 3. Already moving above the lockout line → no sheet: a pocket drive starts with
 *    `evidence: 'movingStart'` — not manual-start evidence for the role (rev1: I10) — "Recording"
 *    is spoken and the pocket screen shows. No taps are requested of a moving driver.
 * 4. Otherwise the sheet: Mounted/Pocket (remembered as `drive.lastMode`), the passenger toggle,
 *    the GPS / battery / hot chips, the low-battery Pocket suggestion, VoiceOver focus on Start.
 *    **Start drive** → `manualStart({ …, evidence: 'tap' })` → "Recording" → HUD or pocket.
 *
 * Battery (§3.5): the chips read once, and the GPS watch runs only while this sheet is on screen.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  Switch,
  View,
} from 'react-native';
import DriveSense, { type ThermalLevel } from '@drive-sense';

import type { AppStateLike } from '@/data/foreground';
import { useDriveHost } from '@/drive/useDrive';
import { Field } from '@/features/trips/Field';
import { HOME_HREF } from '@/features/trips/routes';
import { Banner, Button, Card, Screen, Skeleton, Text, useTheme } from '@/ui';

import { DRIVE_ROUTES, driveHref } from './hudCopy';
import { currentSpeedMps, isMovingStart } from './movingCheck';
import {
  ensureDrivePermissions,
  openAppSettings,
  readLocationPermission,
  type DrivePermissions,
  type LocationPermission,
} from './permissions';
import { startCopy as copy } from './startCopy';

/** Settings key of the last mode the driver chose on this sheet (§7.C C1 "remembers last choice"). */
export const LAST_MODE_SETTING_KEY = 'drive.lastMode';
/** §7.C C1: "Battery < 15 % and not charging: suggest Pocket mode". */
export const LOW_BATTERY_PCT = 15;
/** A fix this tight is one the drive can use (the recorder's validity line). */
export const GPS_READY_ACCURACY_M = 50;

// U2's routes (`app/drive/hud.tsx`, `app/drive/pocket.tsx`), named once in its `hudCopy.ts`.
export const HUD_HREF = driveHref(DRIVE_ROUTES.hud);
export const POCKET_HREF = driveHref(DRIVE_ROUTES.pocket);

const START_MIN_HEIGHT = 64;
const CONTROL_MIN_HEIGHT = 52;

/** The two modes a driver picks here (`auto` is the engine's, for detected drives). */
export type DriveMode = 'mounted' | 'pocket';
export type GpsChip = 'ready' | 'searching';
export interface PowerReading {
  pct: number;
  charging: boolean;
}

// ——— the sheet itself (presentational) ———

export interface PreDriveSheetProps {
  initialMode: DriveMode;
  gps: GpsChip;
  /** null when the battery can't be read (a simulator): no chip rather than a guess. */
  power: PowerReading | null;
  hot: boolean;
  starting: boolean;
  error: string | null;
  onStart(choice: { mode: DriveMode; passenger: boolean }): void;
  onCancel(): void;
}

function Chip({
  icon,
  label,
  tone,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  tone: 'good' | 'neutral' | 'warning';
}) {
  const t = useTheme();
  const ink = { good: t.colors.success, neutral: t.colors.textMuted, warning: t.colors.warning }[tone];
  const wash = { good: t.colors.successFaint, neutral: t.colors.surfaceRaised, warning: t.colors.warningFaint }[
    tone
  ];
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.space.xs,
        paddingHorizontal: t.space.md,
        paddingVertical: t.space.xs,
        borderRadius: t.radius.pill,
        borderWidth: 1,
        borderColor: ink,
        backgroundColor: wash,
      }}
    >
      <Ionicons name={icon} size={14} color={ink} />
      <Text variant="footnote" style={{ color: tone === 'neutral' ? t.colors.text : ink }}>
        {label}
      </Text>
    </View>
  );
}

function ModeOption({
  label,
  icon,
  selected,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  selected: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: CONTROL_MIN_HEIGHT,
        borderRadius: t.radius.md,
        borderWidth: selected ? 0 : 1.5,
        borderColor: t.colors.borderStrong,
        backgroundColor: selected ? t.colors.accent : t.colors.surface,
        opacity: pressed ? 0.85 : 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: t.space.sm,
        paddingHorizontal: t.space.md,
      })}
    >
      <Ionicons name={icon} size={20} color={selected ? t.colors.accentText : t.colors.accent} />
      <Text variant="headline" style={{ color: selected ? t.colors.accentText : t.colors.text }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function PreDriveSheet({
  initialMode,
  gps,
  power,
  hot,
  starting,
  error,
  onStart,
  onCancel,
}: PreDriveSheetProps) {
  const t = useTheme();
  const [mode, setMode] = useState<DriveMode>(initialMode);
  const [passenger, setPassenger] = useState(false);
  const startRef = useRef<View>(null);

  // §7.C C1 A11y: "VoiceOver default focus on Start".
  useEffect(() => {
    const target = startRef.current;
    if (target) AccessibilityInfo.sendAccessibilityEvent(target, 'focus');
  }, []);

  const lowBattery = power !== null && !power.charging && power.pct < LOW_BATTERY_PCT;

  return (
    <Screen>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: t.space.lg, paddingBottom: t.space.sm }}
        showsVerticalScrollIndicator={false}
      >
        <Text variant="title2" accessibilityRole="header">
          {copy.sheet.title}
        </Text>

        <Card variant="license">
          <Field label={copy.sheet.modeLabel}>
            <View
              accessibilityRole="radiogroup"
              style={{ flexDirection: 'row', gap: t.space.sm, paddingTop: t.space.xs }}
            >
              <ModeOption
                label={copy.sheet.mounted}
                icon="phone-portrait-outline"
                selected={mode === 'mounted'}
                onPress={() => setMode('mounted')}
              />
              <ModeOption
                label={copy.sheet.pocket}
                icon="volume-medium-outline"
                selected={mode === 'pocket'}
                onPress={() => setMode('pocket')}
              />
            </View>
            <Text variant="footnote" tone="muted">
              {mode === 'mounted' ? copy.sheet.mountedHint : copy.sheet.pocketHint}
            </Text>
          </Field>

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: t.space.md,
              minHeight: 44,
              paddingTop: t.space.sm,
            }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="headline">{copy.sheet.passenger}</Text>
              <Text variant="footnote" tone="muted">
                {copy.sheet.passengerHint}
              </Text>
            </View>
            <Switch
              accessibilityRole="switch"
              accessibilityLabel={copy.sheet.passenger}
              accessibilityHint={copy.sheet.passengerHint}
              value={passenger}
              onValueChange={setPassenger}
              trackColor={{ true: t.colors.accent, false: t.colors.border }}
            />
          </View>
        </Card>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
          {gps === 'ready' ? (
            <Chip icon="navigate" label={copy.chips.gpsReady} tone="good" />
          ) : (
            <Chip icon="navigate-outline" label={copy.chips.gpsSearching} tone="neutral" />
          )}
          {power ? (
            <Chip
              icon={power.charging ? 'battery-charging-outline' : lowBattery ? 'battery-dead-outline' : 'battery-half-outline'}
              label={power.charging ? copy.chips.charging(power.pct) : copy.chips.battery(power.pct)}
              tone={lowBattery ? 'warning' : 'neutral'}
            />
          ) : null}
          {hot ? <Chip icon="thermometer-outline" label={copy.chips.hot} tone="warning" /> : null}
        </View>

        {lowBattery && mode === 'mounted' ? (
          <Banner
            tone="warning"
            message={copy.lowBattery.message(power.pct)}
            action={{ label: copy.lowBattery.action, onPress: () => setMode('pocket') }}
          />
        ) : null}

        {error ? <Banner tone="danger" message={error} /> : null}
      </ScrollView>

      <View style={{ gap: t.space.sm }}>
        <Pressable
          ref={startRef}
          accessibilityRole="button"
          accessibilityLabel={copy.sheet.start}
          accessibilityState={{ disabled: starting, busy: starting }}
          disabled={starting}
          onPress={() => onStart({ mode, passenger })}
          style={({ pressed }) => ({
            minHeight: START_MIN_HEIGHT,
            borderRadius: t.radius.md,
            backgroundColor: t.colors.accent,
            opacity: starting ? 0.6 : pressed ? 0.85 : 1,
            transform: [{ scale: pressed && !starting ? 0.98 : 1 }],
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'row',
            gap: t.space.sm,
          })}
        >
          {starting ? (
            <ActivityIndicator color={t.colors.accentText} accessibilityLabel={copy.sheet.starting} />
          ) : (
            <>
              <Ionicons name="play" size={22} color={t.colors.accentText} />
              <Text variant="title2" style={{ color: t.colors.accentText }}>
                {copy.sheet.start}
              </Text>
            </>
          )}
        </Pressable>
        <Button label={copy.sheet.cancel} variant="ghost" size="md" onPress={onCancel} />
      </View>
    </Screen>
  );
}

// ——— location denied (§7.0 permission-denied explainer) ———

export function LocationDeniedExplainer({
  onOpenSettings,
  onNotNow,
}: {
  onOpenSettings: () => void;
  onNotNow: () => void;
}) {
  const t = useTheme();
  return (
    <Screen>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: t.space.lg }}>
        <Ionicons name="location-outline" size={32} color={t.colors.accent} accessibilityElementsHidden />
        <Text variant="title2" accessibilityRole="header">
          {copy.locationDenied.title}
        </Text>
        <Text variant="body">{copy.locationDenied.body}</Text>
        <Text variant="body" tone="muted">
          {copy.locationDenied.steps}
        </Text>
      </ScrollView>
      <View style={{ gap: t.space.sm }}>
        <Button label={copy.locationDenied.openSettings} size="hud" onPress={onOpenSettings} />
        <Button label={copy.locationDenied.notNow} variant="ghost" size="md" onPress={onNotNow} />
      </View>
    </Screen>
  );
}

// ——— the route logic ———

export interface StartProbes {
  /** Calls back with each fix's horizontal accuracy (m); resolves to a stop function. */
  watchGps(cb: (accuracyM: number | null) => void): Promise<() => void>;
  power(): Promise<PowerReading | null>;
  thermal(): Promise<ThermalLevel | null>;
}

export interface StartDeps {
  ensurePermissions(): Promise<DrivePermissions>;
  readLocationPermission(): Promise<LocationPermission>;
  openSettings(): Promise<void>;
  currentSpeedMps(): Promise<number | null>;
  settings: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
  };
  probes: StartProbes;
  appState: AppStateLike;
}

export const defaultProbes: StartProbes = {
  async watchGps(cb) {
    const sub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 0 },
      (fix) => cb(fix.coords.accuracy ?? null)
    );
    return () => sub.remove();
  },
  async power() {
    try {
      const p = await Battery.getPowerStateAsync();
      if (!(p.batteryLevel >= 0)) return null;
      const charging =
        p.batteryState === Battery.BatteryState.CHARGING || p.batteryState === Battery.BatteryState.FULL;
      return { pct: Math.round(p.batteryLevel * 100), charging };
    } catch {
      return null;
    }
  },
  async thermal() {
    try {
      return await DriveSense.getThermalState();
    } catch {
      return null;
    }
  },
};

/** The deps a route passes when it has only a settings repo to add. */
export function defaultStartDeps(settings: StartDeps['settings']): StartDeps {
  return {
    ensurePermissions: () => ensureDrivePermissions(),
    readLocationPermission: () => readLocationPermission(),
    openSettings: openAppSettings,
    currentSpeedMps: () => currentSpeedMps(),
    settings,
    probes: defaultProbes,
    appState: AppState,
  };
}

type Phase = 'checking' | 'denied' | 'sheet' | 'leaving';

function useSheetStatus(probes: StartProbes, active: boolean) {
  const [gps, setGps] = useState<GpsChip>('searching');
  const [power, setPower] = useState<PowerReading | null>(null);
  const [hot, setHot] = useState(false);

  useEffect(() => {
    if (!active) return;
    let live = true;
    let stop: (() => void) | null = null;
    probes
      .watchGps((acc) => {
        if (live && acc !== null && acc <= GPS_READY_ACCURACY_M) setGps('ready');
      })
      .then(
        (s) => {
          if (live) stop = s;
          else s();
        },
        () => {}
      );
    probes.power().then((p) => live && setPower(p), () => {});
    probes
      .thermal()
      .then((th) => live && setHot(th === 'serious' || th === 'critical'), () => {});
    return () => {
      live = false;
      stop?.();
    };
  }, [probes, active]);

  return { gps, power, hot };
}

export function DriveStartScreen({ deps }: { deps: StartDeps }) {
  const router = useRouter();
  const host = useDriveHost();
  const t = useTheme();
  const [phase, setPhase] = useState<Phase>('checking');
  const [initialMode, setInitialMode] = useState<DriveMode>('mounted');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const toHome = useCallback(() => {
    setPhase('leaving');
    router.replace(HOME_HREF);
  }, [router]);

  const announceRecording = useCallback(() => {
    void host.announce('alert.recording').catch(() => {});
  }, [host]);

  /** Everything after the permission check: the moving test, then the sheet. */
  const proceed = useCallback(async () => {
    const speed = await deps.currentSpeedMps();
    if (!live.current) return;
    if (isMovingStart(speed)) {
      if (host.isBusy()) return toHome();
      setPhase('leaving');
      try {
        await host.manualStart({ mode: 'pocket', passenger: false, evidence: 'movingStart' });
      } catch {
        // Not started: the sheet (with its error line) is the honest fallback — nothing is spoken.
        if (!live.current) return;
        setError(copy.sheet.startFailed);
        setInitialMode('pocket');
        setPhase('sheet');
        return;
      }
      announceRecording();
      router.replace(POCKET_HREF);
      return;
    }
    const remembered = await deps.settings.get<DriveMode>(LAST_MODE_SETTING_KEY).catch(() => null);
    if (!live.current) return;
    setInitialMode(remembered === 'pocket' ? 'pocket' : 'mounted');
    setPhase('sheet');
  }, [deps, host, router, toHome, announceRecording]);

  // The entry sequence, once.
  useEffect(() => {
    if (host.isBusy()) {
      // Home carries the in-progress banner. Nothing is asked, started or announced.
      router.replace(HOME_HREF);
      return;
    }
    void (async () => {
      const perms = await deps.ensurePermissions();
      if (!live.current) return;
      if (perms.location !== 'granted') {
        setPhase('denied');
        return;
      }
      await proceed();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the entry runs once per mount
  }, []);

  // Back from Settings: re-read (never re-ask); granted → carry on.
  useEffect(() => {
    if (phase !== 'denied') return;
    const sub = deps.appState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      void deps.readLocationPermission().then((p) => {
        if (!live.current || p !== 'granted') return;
        if (host.isBusy()) return toHome();
        setPhase('checking');
        void proceed();
      });
    });
    return () => sub.remove();
  }, [phase, deps, host, proceed, toHome]);

  const status = useSheetStatus(deps.probes, phase === 'sheet');

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(HOME_HREF);
  }, [router]);

  const onStart = useCallback(
    async ({ mode, passenger }: { mode: DriveMode; passenger: boolean }) => {
      if (starting) return;
      // An auto-detected drive may have begun while the sheet was open: never a second one.
      if (host.isBusy()) return toHome();
      setStarting(true);
      setError(null);
      try {
        await host.manualStart({ mode, passenger, evidence: 'tap' });
      } catch {
        if (!live.current) return;
        setStarting(false);
        setError(copy.sheet.startFailed);
        return;
      }
      void deps.settings.set(LAST_MODE_SETTING_KEY, mode).catch(() => {});
      announceRecording();
      router.replace(mode === 'mounted' ? HUD_HREF : POCKET_HREF);
    },
    [starting, host, deps, router, toHome, announceRecording]
  );

  if (phase === 'denied') {
    return (
      <LocationDeniedExplainer
        onOpenSettings={() => void deps.openSettings().catch(() => {})}
        onNotNow={leave}
      />
    );
  }

  if (phase === 'sheet') {
    return (
      <PreDriveSheet
        initialMode={initialMode}
        gps={status.gps}
        power={status.power}
        hot={status.hot}
        starting={starting}
        error={error}
        onStart={(c) => void onStart(c)}
        onCancel={leave}
      />
    );
  }

  // Checking (bounded: one permission read and at most 2 s for a fix) or leaving: the sheet's
  // shape, unprinted, so the screen is never blank and never a spinner.
  return (
    <Screen>
      <View accessible accessibilityLabel={copy.sheet.checking} style={{ gap: t.space.lg }}>
        <Skeleton width="55%" height={28} />
        <Skeleton width="100%" height={180} radius={t.radius.lg} />
        <Skeleton width="70%" height={28} radius={t.radius.pill} />
      </View>
    </Screen>
  );
}

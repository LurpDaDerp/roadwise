import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type GestureResponderEvent,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { STOPPED_PANEL_CLEAR_MPS } from '@/core/engine/machine';
import type { DriveHost, DriveState } from '@/drive/host';
import { isBusyStatus, isIdleStatus } from '@/drive/policy';
import { useDrive, useDriveHost } from '@/drive/useDrive';
import { sunIsDown } from '@/lib/time';
import { tokens, useTheme } from '@/ui';
import { fontFamilies } from '@/ui/fonts';
import {
  AlertOverlay,
  HazardChip,
  HudIndicators,
  type HudStatusLevel,
  hudLabelScale,
  hudPalette,
  SpeedReadout,
  SpeedSign,
  StatusRing,
} from '@/ui/drive';

import { DRIVE_ROUTES, driveHref, hudCopy } from './hudCopy';
import { StoppedPanel } from './StoppedPanel';

/** C3 / §3.3: the one touch honoured while moving is a hold this long, and it mutes only the current alert. */
export const HUD_MUTE_HOLD_MS = 1500;
/** How often the HUD re-reads the sun (the night palette follows sunset within a few minutes). */
export const HUD_NIGHT_RECHECK_MS = 5 * 60_000;
/** A cached position older than this says little about where the car is now. */
const POSITION_MAX_AGE_MS = 60 * 60_000;
/** C1: below this the battery warning shows (and the pre-drive sheet suggests pocket mode). */
const BATTERY_LOW = 0.15;

/**
 * The whole screen goes dark-adapted at night, judged by the sun at the phone's last known position
 * (`sunIsDown`, civil twilight), starting from the host's clock-based night on the first paint.
 * The position is the OS's cached fix — reading it starts no GPS and
 * costs no battery beyond the drive's own capture. With no cached fix the host's own night rule
 * (the detectors' clock-based night) decides, so the HUD never guesses a location.
 *
 * Re-checked every few minutes while the HUD is on screen; nothing runs when it is not.
 */
function useHudNight(host: Pick<DriveHost, 'detectorContext'>): boolean {
  // The first paint already has an answer — the host's synchronous clock-based night — so a HUD
  // mounting in a dark cabin never flashes the day palette while the position is read (review m1).
  const [night, setNight] = useState(() => host.detectorContext().night);
  useEffect(() => {
    const fallback = () => host.detectorContext().night;
    let live = true;
    const check = async () => {
      let next: boolean;
      try {
        const pos = await Location.getLastKnownPositionAsync({ maxAge: POSITION_MAX_AGE_MS });
        next = pos ? sunIsDown(new Date(), pos.coords.latitude, pos.coords.longitude) : fallback();
      } catch {
        next = fallback();
      }
      if (live) setNight(next);
    };
    void check();
    const timer = setInterval(() => void check(), HUD_NIGHT_RECHECK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [host]);
  return night;
}

/**
 * `finalizing` → the end screen (C8). Only a screen that watched a drive of its own go by routes:
 * a close can reach React already batched to `armed` (finalize → armed inside one host task), so
 * reaching idle after a drive counts too, while a HUD opened with no drive never claims one ended.
 */
export function useEndOfDriveRouting(enabled: boolean): void {
  const router = useRouter();
  const status = useDrive((s) => s.status);
  const sawDrive = useRef(false);
  const routed = useRef(false);
  useEffect(() => {
    if (!enabled || routed.current) return;
    if (status === 'finalizing' || (isIdleStatus(status) && sawDrive.current)) {
      routed.current = true;
      router.replace(driveHref(DRIVE_ROUTES.end));
      return;
    }
    if (isBusyStatus(status)) sawDrive.current = true;
  }, [enabled, status, router]);
}

/**
 * Whether a tap may bring up the drive controls on a screen that is not already showing them: the
 * drive is open, the lockout is off, the speed is not stale after an adopt, and the car is not
 * known to be rolling. An ordinary start in a garage (no fix yet) qualifies — the driver can still
 * end a drive begun by mistake — while a tunnel at speed does not: the lockout holds at the last
 * known speed (SR2).
 */
export function mayRevealControls(
  s: Pick<
    DriveState,
    'status' | 'lockedOut' | 'awaitingSpeedAfterResume' | 'speedKnown' | 'speedMps'
  >
): boolean {
  if (s.status !== 'recording' && s.status !== 'ending') return false;
  if (s.lockedOut || s.awaitingSpeedAfterResume) return false;
  return !s.speedKnown || s.speedMps <= STOPPED_PANEL_CLEAR_MPS;
}

/**
 * The stopped panel's visibility for one screen. The engine's own C6 signal (`stoppedPanel`, or
 * the gap window) shows it where `auto` is set; a tap can ask for it whenever `mayRevealControls`
 * holds, and the ask lapses the moment that stops holding, so stopping again later needs a new tap.
 */
export function useStoppedPanel(auto: boolean): { visible: boolean; reveal: () => void } {
  // Booleans only, so a row that changes nothing here re-renders nothing (review m3).
  const { allowed, engineSays } = useDrive((d) => ({
    allowed: mayRevealControls(d),
    engineSays: d.stoppedPanel || (d.status === 'ending' && !d.lockedOut),
  }));
  const [asked, setAsked] = useState(false);
  // The ask lapses as soon as it is no longer allowed (adjusting state while rendering, not in an
  // effect, so the panel never shows for a frame after the car moves off).
  const [wasAllowed, setWasAllowed] = useState(allowed);
  if (allowed !== wasAllowed) {
    setWasAllowed(allowed);
    if (!allowed) setAsked(false);
  }
  const reveal = useCallback(() => {
    if (allowed) setAsked(true);
  }, [allowed]);
  return { visible: (auto && engineSays) || (asked && allowed), reveal };
}

/** Stop-panel actions for a routed drive screen: End goes to the end screen first, then ends. */
export function useStoppedActions() {
  const host = useDriveHost();
  const router = useRouter();
  return useMemo(
    () => ({
      // The end screen captures the trip id as it mounts, so it opens while the trip is still set.
      onEnd: () => {
        router.replace(driveHref(DRIVE_ROUTES.end));
        void host.end();
      },
      onMuteForDrive: () => void host.muteForDrive(),
      onSetPassenger: (passenger: boolean) => void host.setPassenger(passenger),
    }),
    [host, router]
  );
}

/**
 * Zones 1 and 2. The only part of the HUD that reads the 1 Hz speed, so a row re-renders the
 * readout and the sign and nothing else (review m3). Both are memoised on what they display.
 */
const SpeedGauges = memo(function SpeedGauges({
  landscape,
  night,
}: {
  landscape: boolean;
  night: boolean;
}) {
  const speedMps = useDrive((s) => s.speedMps);
  const speedKnown = useDrive((s) => s.speedKnown);
  const limit = useDrive((s) => s.limit);
  return (
    <View
      testID={landscape ? 'hud-layout-landscape' : 'hud-layout-portrait'}
      style={[styles.gauges, landscape ? styles.gaugesLandscape : styles.gaugesPortrait]}
    >
      <SpeedReadout speedMps={speedMps} speedKnown={speedKnown} limit={limit} night={night} />
      <SpeedSign limit={limit} speedKnown={speedKnown} night={night} />
    </View>
  );
});

function statusLevel(level: 1 | 2 | 3 | undefined): HudStatusLevel {
  if (level === 3) return 'critical';
  if (level === 1 || level === 2) return 'attention';
  return 'calm';
}

/**
 * The touch shield (C3, SR2): while locked out, or while the speed is stale after an adopt, it lies
 * over the whole HUD and takes every touch — taps, swipes, a palm — and keeps it (it never yields
 * the responder). The only thing a touch can do is a hold of `HUD_MUTE_HOLD_MS`, which mutes the
 * alert sounding now. The timer exists only while a finger is down.
 */
function TouchShield({ onHold }: { onHold: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  return (
    <View
      testID="hud-touch-shield"
      style={StyleSheet.absoluteFill}
      accessibilityLabel={hudCopy.hud.shieldLabel}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(_e: GestureResponderEvent) => {
        clear();
        timer.current = setTimeout(() => {
          timer.current = null;
          onHold();
        }, HUD_MUTE_HOLD_MS);
      }}
      onResponderRelease={clear}
      onResponderTerminate={clear}
    />
  );
}

/** Only an explicit false means the alert audio failed; absent (older hosts) counts as available. */
export const useAlertsUnavailable = (): boolean => useDrive((s) => s.alertsAvailable === false);

/**
 * "Sound alerts unavailable" (ruling H2 item 6): the alert audio failed to load, the drive still
 * records, and the driver must not believe they would hear a warning. A drawn mark and three words
 * in the quiet indicator ink — calm, no colour alarm, no motion — and not a control: nothing to
 * press at speed. `ink` lets the pocket screen draw it in its own dim print.
 */
export const AlertsUnavailableMark = memo(function AlertsUnavailableMark({ ink }: { ink: string }) {
  const { fontScale } = useWindowDimensions();
  const size = 15 * hudLabelScale(fontScale);
  return (
    <View
      testID="hud-alerts-unavailable"
      accessible
      accessibilityRole="text"
      accessibilityLabel={hudCopy.alerts.label}
      style={styles.alertsMark}
    >
      <MaterialCommunityIcons name="volume-off" size={22} color={ink} />
      <Text
        allowFontScaling={false}
        style={[
          styles.alertsWords,
          { color: ink, fontSize: size, lineHeight: Math.round(size * 1.25) },
        ]}
      >
        {hudCopy.alerts.unavailable}
      </Text>
    </View>
  );
});

export type HudScreenProps = {
  /**
   * Drawn by the lockout gate over another route rather than as the `/drive/hud` route: it only
   * ever shows while locked out, so it offers no stopped panel and never navigates.
   */
  overlay?: boolean;
};

/**
 * C3, the mounted drive HUD. Three zones — the speed, the limit sign beside it, the status strip —
 * plus at most one hazard chip (night, in M3), the corner indicators, and the alert overlay on top.
 * True black in every light; the night palette by the sun. Portrait and landscape.
 *
 * Every value passes through U1's components raw, so the one limit gate (`limitActionable` with
 * `speedKnown`) decides what the sign may say. No text beyond three words while moving (SR3), and
 * failure is silent: lost GPS is the crossed-out mark and "—", never words (SR9).
 */
export function HudScreen({ overlay = false }: HudScreenProps) {
  const host = useDriveHost();
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  const status = useDrive((s) => s.status);
  const activeAlert = useDrive((s) => s.activeAlert);
  const ind = useDrive((s) => ({
    gps: s.gps,
    thermal: s.thermal,
    passenger: s.role === 'passenger',
    mutedForDrive: s.mutedForDrive,
  }));
  const shielded = useDrive((s) => s.lockedOut || s.awaitingSpeedAfterResume);
  const alertsUnavailable = useAlertsUnavailable();

  const night = useHudNight(host);
  const battery = Battery.useBatteryLevel();
  const batteryLow = battery >= 0 && battery < BATTERY_LOW;

  useEndOfDriveRouting(!overlay);
  const panel = useStoppedPanel(true);
  const actions = useStoppedActions();
  const panelVisible = !overlay && !shielded && panel.visible;

  const muteCurrent = useCallback(() => void host.muteCurrentAlert(), [host]);
  const p = hudPalette(night);
  const recording = status === 'recording';

  return (
    <View testID="hud-screen" style={[styles.root, { backgroundColor: p.ground }]}>
      <Pressable
        testID="hud-tap-area"
        accessible={false}
        onPress={panel.reveal}
        style={[
          styles.fill,
          {
            paddingTop: insets.top + tokens.space.sm,
            paddingBottom: insets.bottom + tokens.space.sm,
            paddingLeft: insets.left + tokens.space.lg,
            paddingRight: insets.right + tokens.space.lg,
          },
        ]}
      >
        <View style={styles.topRow}>
          <HazardChip kind={night ? 'night' : null} night={night} />
          <View style={styles.spacer} />
          <HudIndicators
            gps={ind.gps}
            thermal={ind.thermal}
            batteryLow={batteryLow}
            passenger={ind.passenger}
            night={night}
          />
        </View>
        {alertsUnavailable ? <AlertsUnavailableMark ink={p.inkMuted} /> : null}
        <SpeedGauges landscape={landscape} night={night} />
        {recording ? (
          <StatusRing level={statusLevel(activeAlert?.level)} recording night={night} />
        ) : (
          <View style={styles.ringSpace} />
        )}
      </Pressable>
      <StoppedPanel
        visible={panelVisible}
        passenger={ind.passenger}
        mutedForDrive={ind.mutedForDrive}
        night={night}
        reduceMotion={th.reduceMotion}
        {...actions}
      />
      <AlertOverlay decision={activeAlert} night={night} reduceMotion={th.reduceMotion} />
      {shielded ? <TouchShield onHold={muteCurrent} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fill: { flex: 1, justifyContent: 'space-between' },
  topRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  spacer: { flex: 1 },
  alertsMark: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.space.sm,
  },
  alertsWords: { fontFamily: fontFamilies.field, textAlign: 'center' },
  gauges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gaugesPortrait: { gap: tokens.space.lg },
  gaugesLandscape: { gap: tokens.space.xxxl },
  ringSpace: { height: 22 },
});

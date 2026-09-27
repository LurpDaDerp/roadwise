import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { STOPPED_PANEL_CLEAR_MPS } from '@/core/engine/machine';
import type { DriveHost, DriveState } from '@/drive/host';
import { isBusyStatus, isIdleStatus } from '@/drive/policy';
import { useDrive, useDriveHost } from '@/drive/useDrive';
import { sunIsDown } from '@/lib/time';
import { tokens } from '@/ui';
import {
  type HaloLevel,
  haloLevel,
  haloSize,
  HoldButton,
  hudPalette,
  overLimitMps,
  SpeedReadout,
  SpeedSign,
  speedNumeralPt,
  StatusHalo,
} from '@/ui/drive';

import { deviceEmergencyNumber, emergencyTelUrl } from './emergency';
import { bannerOf, EventBanner } from './EventBanner';
import { HAZARD_BAR_PT, HazardBar } from './HazardBar';
import { DRIVE_ROUTES, driveHref, hudCopy } from './hudCopy';
import { tripMinutes, TripTimer } from './TripTimer';
import { useWeatherHazard } from './weather';

/** How often the HUD re-reads the sun (the night palette follows sunset within a few minutes). */
export const HUD_NIGHT_RECHECK_MS = 5 * 60_000;
/** A cached position older than this says little about where the car is now. */
const POSITION_MAX_AGE_MS = 60 * 60_000;
/** The bottom bar's height: SOS, the timer and End, with room for a hold. */
const BOTTOM_BAR_PT = 88;
/** The End button's footprint, kept when there is no drive to end, so nothing shifts. */
const END_SLOT_PT = 128;

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
 * Whether a tap may bring up the drive controls on a screen that is not already showing them (the
 * pocket screen, C4c): the drive is open, the lockout is off, the speed is not stale after an
 * adopt, and the car is not known to be rolling. An ordinary start in a garage (no fix yet)
 * qualifies — the driver can still end a drive begun by mistake — while a tunnel at speed does
 * not: the lockout holds at the last known speed (SR2).
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
 * The stopped panel's visibility for one screen (the pocket screen). The engine's own C6 signal
 * (`stoppedPanel`, or the gap window) shows it where `auto` is set; a tap can ask for it whenever
 * `mayRevealControls` holds, and the ask lapses the moment that stops holding, so stopping again
 * later needs a new tap.
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

/** Drive actions for a routed drive screen: End goes to the end screen first, then ends. */
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
 * The halo's level for a snapshot: the speed against the shown limit, the alert now showing, and
 * the age of the last harsh event on the row clock. A primitive, so a row that changes the number
 * but not the level re-renders nothing here.
 */
export function haloLevelOf(
  s: Pick<
    DriveState,
    'speedMps' | 'speedKnown' | 'limit' | 'activeAlert' | 'harshEvent' | 'lastRowTs'
  >
): HaloLevel {
  return haloLevel({
    overMps: overLimitMps(s.speedMps, s.speedKnown, s.limit),
    alertLevel: s.activeAlert?.level ?? null,
    harshAgeMs:
      s.harshEvent != null && s.lastRowTs !== null ? s.lastRowTs - s.harshEvent.ts : null,
  });
}

/** The only part of the HUD that reads the 1 Hz speed for display; memoised on what it shows. */
const Speed = memo(function Speed({
  level,
  night,
  size,
}: {
  level: HaloLevel;
  night: boolean;
  size: number;
}) {
  const speedMps = useDrive((s) => s.speedMps);
  const speedKnown = useDrive((s) => s.speedKnown);
  const limit = useDrive((s) => s.limit);
  return (
    <SpeedReadout
      speedMps={speedMps}
      speedKnown={speedKnown}
      limit={limit}
      level={level}
      night={night}
      size={size}
    />
  );
});

const Limit = memo(function Limit({ night }: { night: boolean }) {
  const limit = useDrive((s) => s.limit);
  const speedKnown = useDrive((s) => s.speedKnown);
  return <SpeedSign limit={limit} speedKnown={speedKnown} night={night} />;
});

/**
 * The centre zone: the halo with the speed inside and the limit sign beside (landscape) or under
 * (portrait) it. It reads the snapshot only as a halo level, so a row that changes the number but
 * not the level re-renders the readout and nothing else.
 */
const Gauges = memo(function Gauges({
  recording,
  night,
  ring,
}: {
  recording: boolean;
  night: boolean;
  ring: number;
}) {
  const level = useDrive(haloLevelOf);
  return (
    <>
      <StatusHalo level={level} size={ring} recording={recording} night={night}>
        <Speed level={level} night={night} size={speedNumeralPt(ring)} />
      </StatusHalo>
      <Limit night={night} />
    </>
  );
});

const Timer = memo(function Timer({ night }: { night: boolean }) {
  const minutes = useDrive(tripMinutes);
  return <TripTimer minutes={minutes} night={night} />;
});

const Banner = memo(function Banner({ night }: { night: boolean }) {
  const banner = useDrive(bannerOf);
  return banner ? <EventBanner event={banner} night={night} /> : null;
});

export type HudScreenProps = {
  /**
   * Drawn by the lockout gate over another route rather than as the `/drive/hud` route: it never
   * routes at the end of the drive on its own, and its End pushes the end screen like the
   * in-progress banner does.
   */
  overlay?: boolean;
};

/**
 * C3, the mounted drive HUD. Top: the weather hazard bar, empty unless there is one. Centre: the
 * status halo with the speed inside it and the limit sign with it. Bottom: SOS at the left, the
 * trip timer in the middle, End at the right — the two controls are hold-to-act, so they stay
 * live at speed (a knock cannot fire them), and nothing else on the screen takes a touch. Over
 * it all, for a few seconds at a time, the event banner. Ink-black in every light; the night
 * palette by the sun. Portrait and landscape.
 *
 * Nothing here runs on a timer but the sun check and the weather refresh: the banner, the halo's
 * harsh-event window and the trip minutes all follow the row clock in the snapshot, each through
 * a selector that re-renders only when its answer changes.
 *
 * Every value passes through U1's components raw, so the one limit gate (`limitActionable` with
 * `speedKnown`) decides what the sign may say. No text beyond three words while moving (SR3), and
 * failure is silent: lost GPS is "—", never words (SR9); no weather is an empty bar.
 */
export function HudScreen({ overlay = false }: HudScreenProps) {
  const host = useDriveHost();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  const status = useDrive((s) => s.status);
  const night = useHudNight(host);
  const recording = status === 'recording';
  const tripOpen = recording || status === 'ending';

  useEndOfDriveRouting(!overlay);
  const actions = useStoppedActions();
  const hazard = useWeatherHazard(recording);

  const onSos = useCallback(() => {
    Linking.openURL(emergencyTelUrl(deviceEmergencyNumber())).catch(() => {});
  }, []);
  const onEnd = useCallback(() => {
    if (!overlay) {
      actions.onEnd();
      return;
    }
    // The overlay lies over another route, not on one of its own: like the in-progress banner it
    // pushes the end screen (which captures the trip as it mounts), then ends the drive.
    router.push(driveHref(DRIVE_ROUTES.end));
    void host.end();
  }, [overlay, actions, router, host]);

  const p = hudPalette(night);
  const pad = {
    top: insets.top + tokens.space.sm,
    bottom: insets.bottom + tokens.space.md,
    left: insets.left + tokens.space.lg,
    right: insets.right + tokens.space.lg,
  };
  const ring = haloSize(
    width - pad.left - pad.right,
    height - pad.top - pad.bottom - HAZARD_BAR_PT - BOTTOM_BAR_PT,
    landscape
  );

  return (
    <View
      testID="hud-screen"
      style={[
        styles.root,
        {
          backgroundColor: p.ground,
          paddingTop: pad.top,
          paddingBottom: pad.bottom,
          paddingLeft: pad.left,
          paddingRight: pad.right,
        },
      ]}
    >
      <HazardBar hazard={hazard} night={night} />
      <View
        testID={landscape ? 'hud-layout-landscape' : 'hud-layout-portrait'}
        style={[styles.centre, landscape ? styles.centreLandscape : styles.centrePortrait]}
      >
        <Gauges recording={recording} night={night} ring={ring} />
      </View>
      <View style={styles.bottom}>
        <HoldButton
          testID="hud-sos"
          shape="circle"
          label={hudCopy.hud.sos}
          accessibilityLabel={hudCopy.hud.sosLabel}
          accessibilityHint={hudCopy.hud.sosHint}
          face={p.sos}
          ink={p.sosInk}
          onHold={onSos}
        />
        <Timer night={night} />
        {tripOpen ? (
          <HoldButton
            testID="hud-end"
            shape="pill"
            label={hudCopy.hud.end}
            accessibilityLabel={hudCopy.hud.endLabel}
            accessibilityHint={hudCopy.hud.endHint}
            face={p.chrome}
            edge={p.chromeEdge}
            ink={p.ink}
            onHold={onEnd}
          />
        ) : (
          <View style={styles.endSlot} />
        )}
      </View>
      <Banner night={night} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  centrePortrait: { flexDirection: 'column', gap: tokens.space.lg },
  centreLandscape: { flexDirection: 'row', gap: tokens.space.xl },
  bottom: {
    height: BOTTOM_BAR_PT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  endSlot: { width: END_SLOT_PT },
});

import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDriveControls, useDriveLive } from '@/drive/useDrive';
import { driveSummaryHref, HOME_HREF } from '@/features/drives/routes';
import { sunIsDown } from '@/lib/time';
import { fontFamilies } from '@/ui/fonts';
import {
  DIM_AFTER_MS,
  DIM_SCRIM_OPACITY,
  EdgeGlow,
  HoldButton,
  type HudPalette,
  hudPalette,
  SpeedReadout,
  SpeedSign,
  speedNumeralPt,
  tierColor,
} from '@/ui/drive';

import { EventBanner, useAlertFlash } from './EventBanner';
import { hudCopy } from './hudCopy';
import { StoppedPoints } from './StoppedPoints';
import { inUnits, unitLabel, useHudUnits } from './useHudUnits';
import { WeatherBanner } from './WeatherBanner';

/** How often the HUD re-reads the sun (the night palette follows sunset within a few minutes). */
export const HUD_NIGHT_RECHECK_MS = 5 * 60_000;
/** A cached position older than this says little about where the car is now. */
const POSITION_MAX_AGE_MS = 60 * 60_000;

/**
 * Night, judged by the sun at the phone's last known position (the OS's cached fix: no GPS of its
 * own). With no cached fix the day palette stays. Re-checked every few minutes while on screen.
 */
function useHudNight(): boolean {
  const [night, setNight] = useState(false);
  useEffect(() => {
    let live = true;
    const check = async () => {
      try {
        const pos = await Location.getLastKnownPositionAsync({ maxAge: POSITION_MAX_AGE_MS });
        if (live && pos) setNight(sunIsDown(new Date(), pos.coords.latitude, pos.coords.longitude));
      } catch {
        // No position: keep what we have.
      }
    };
    void check();
    const timer = setInterval(() => void check(), HUD_NIGHT_RECHECK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return night;
}

/**
 * The screen dims after `DIM_AFTER_MS` without a touch; any touch undims it (and re-arms the
 * timer). It never dims while `hold` is true (an alert is showing). One timer, re-armed per touch;
 * a touch on an undimmed screen changes no state, so it re-renders nothing.
 */
export function useDimmer(hold: boolean): { dimmed: boolean; wake: () => void } {
  const [idle, setIdle] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const arm = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setIdle(true), DIM_AFTER_MS);
  }, []);
  const wake = useCallback(() => {
    setIdle(false);
    arm();
  }, [arm]);
  useEffect(() => {
    arm();
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [arm]);
  return { dimmed: idle && !hold, wake };
}

const DmsDot = memo(function DmsDot({ palette: p, top, right }: { palette: HudPalette; top: number; right: number }) {
  return (
    <View testID="hud-dms" accessible accessibilityLabel={hudCopy.dms} style={[styles.dms, { top, right }]}>
      <Ionicons name="videocam" size={18} color={p.inkMuted} />
    </View>
  );
});

export type HudScreenProps = {
  /**
   * Drawn without a route of its own (the diagnostics simulation): it never navigates, at the end
   * of the drive or after End.
   */
  overlay?: boolean;
};

/**
 * The driving screen (spec "Driving screen"): built to be glanced at, not watched.
 *
 * - Centre: the speed, large, next to a round limit sign ("—" when the limit is unknown).
 * - Edge: a static glow in the speeding tier's colour while speeding; for 1.5 s after an event, a
 *   glow in that event's tier colour with an icon and one or two words at the top. No overlay.
 * - Top: the weather line, only while an alert covers the area. A small camera mark while the DMS
 *   runs.
 * - Stopped only: the points total and the change since the last stop.
 * - Bottom: hold-to-end — the only control, live at any speed. Every other touch only undims.
 * - After 10 s without a touch a dark scrim dims everything (the speed stays faintly readable);
 *   never while an alert glow shows.
 *
 * It re-renders only when `useDriveLive` publishes (≤ 1 Hz) or the alert/dim state flips; every
 * part is memoised on primitives. Motion runs on the UI thread and only while stopped (the points)
 * or under the driver's finger (the End ring).
 */
export function HudScreen({ overlay = false }: HudScreenProps) {
  const live = useDriveLive();
  const controls = useDriveControls();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const night = useHudNight();
  const p = hudPalette(night);
  const units = useHudUnits();

  const alert = useAlertFlash(live.lastAlert);
  const { dimmed, wake } = useDimmer(alert !== null);

  // Where the drive goes once it is over: its summary, fresh, or Home when there was none.
  const lastTripId = useRef<string | null>(live.clientTripId);
  useEffect(() => {
    if (live.clientTripId !== null) lastTripId.current = live.clientTripId;
  }, [live.clientTripId]);
  const navigated = useRef(false);
  const leave = useCallback(
    (clientTripId: string | null) => {
      if (overlay || navigated.current) return;
      navigated.current = true;
      router.replace(clientTripId ? driveSummaryHref(clientTripId, true) : HOME_HREF);
    },
    [overlay, router]
  );

  const [ending, setEnding] = useState(false);
  // A failed end says so (one line at the top) until the next hold.
  const [endFailed, setEndFailed] = useState(false);
  const onEnd = useCallback(async () => {
    if (ending) return;
    setEnding(true);
    setEndFailed(false);
    try {
      const done = await controls.end();
      leave(done?.clientTripId ?? lastTripId.current);
    } catch {
      setEnding(false);
      setEndFailed(true);
    }
  }, [ending, controls, leave]);

  // A drive that ends without the button (the auto-end safety net) still lands on its summary.
  const sawRecording = useRef(false);
  useEffect(() => {
    if (live.status === 'recording') sawRecording.current = true;
    else if (live.status === 'idle' && sawRecording.current && !ending) leave(lastTripId.current);
  }, [live.status, ending, leave]);

  const speeding = live.speedingTier !== null;
  const glow = alert !== null ? tierColor(p, alert.tier) : speeding ? tierColor(p, live.speedingTier!) : null;
  const speedColor = speeding ? tierColor(p, live.speedingTier!) : p.ink;
  const numeral = speedNumeralPt(Math.min(width, height));
  const busy = ending || live.status === 'finalizing';

  return (
    <View testID="hud-screen" onTouchStart={wake} style={[styles.root, { backgroundColor: p.ground }]}>
      <View
        style={[
          styles.frame,
          {
            paddingTop: insets.top + 12,
            paddingBottom: insets.bottom + 16,
            paddingLeft: insets.left + 16,
            paddingRight: insets.right + 16,
          },
        ]}
      >
        <View style={styles.top}>
          {alert !== null ? (
            <EventBanner alert={alert} palette={p} />
          ) : endFailed ? (
            <Text
              testID="hud-end-failed"
              accessibilityRole="alert"
              accessibilityLabel={hudCopy.endFailedLabel}
              allowFontScaling={false}
              style={[styles.note, { color: p.ink }]}
            >
              {hudCopy.endFailed}
            </Text>
          ) : live.weatherAlert !== null ? (
            <WeatherBanner label={live.weatherAlert} palette={p} />
          ) : null}
        </View>

        <View style={styles.centre}>
          <View style={styles.gauges}>
            <SpeedReadout
              speed={inUnits(live.speedMph, units)}
              unit={unitLabel(units)}
              color={speedColor}
              unitColor={p.inkMuted}
              size={numeral}
              speeding={speeding}
            />
            <SpeedSign limit={inUnits(live.limitMph, units)} palette={p} />
          </View>
          {/* Twice guarded: the pipeline publishes points only while stopped, and the screen shows
              them only while the car is known to be stopped (a lost fix is not "stopped"). */}
          {live.stopped && live.points !== null ? (
            <StoppedPoints total={live.points.total} change={live.points.sinceLastStop} palette={p} />
          ) : null}
        </View>

        <View style={styles.bottom}>
          <HoldButton
            testID="hud-end"
            label={busy ? hudCopy.ending : hudCopy.end}
            accessibilityLabel={hudCopy.endLabel}
            accessibilityHint={hudCopy.endHint}
            face={p.chrome}
            ink={p.ink}
            ring={p.ink}
            track={p.chromeEdge}
            disabled={busy}
            onHold={() => void onEnd()}
          />
        </View>
      </View>

      {live.dmsActive ? <DmsDot palette={p} top={insets.top + 8} right={insets.right + 12} /> : null}

      {dimmed ? (
        <View
          testID="hud-dim"
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: p.ground, opacity: DIM_SCRIM_OPACITY }]}
        />
      ) : null}
      {/* Above the scrim: a speeding glow is a safety cue, not decoration. */}
      <EdgeGlow color={glow} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  frame: { flex: 1 },
  top: { minHeight: 56, alignItems: 'center', justifyContent: 'center' },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 28 },
  gauges: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 24 },
  bottom: { alignItems: 'center', justifyContent: 'center' },
  dms: { position: 'absolute', padding: 8 },
  note: { fontFamily: fontFamilies.fieldBold, fontSize: 26, lineHeight: 32 },
});

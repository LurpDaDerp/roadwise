import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DashpalChip, DashpalHudBanner, dashpalTier, useDashpalChip, useDashpalFlash } from '@/dashcam/ui/HudDashpal';
import { useOptionalDb } from '@/data/queries/context';
import { useDrive, useDriveControls, useDriveHost, useDriveLive } from '@/drive/useDrive';
import { driveSummaryHref, HOME_HREF } from '@/features/drives/routes';
import { navAppById } from '@/features/navigation/catalog';
import { NavAppPicker } from '@/features/navigation/NavAppPicker';
import { useNavigationButton } from '@/features/navigation/useNavigationButton';
import { sunIsDown } from '@/lib/time';
import { fontFamilies } from '@/ui/fonts';
import {
  DIM_AFTER_MS,
  DIM_SCRIM_OPACITY,
  EdgeGlow,
  END_BUTTON_PT,
  HoldButton,
  hudPalette,
  SpeedReadout,
  SpeedSign,
  speedNumeralPt,
  tierColor,
} from '@/ui/drive';

import { EventBanner, useAlertFlash } from './EventBanner';
import { hudCopy } from './hudCopy';
import { NAV_HIGHLIGHT_MS, NavigationButton } from './NavigationButton';
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
 * - DashPal (when paired): a small static chip top right with a state dot; for 1.5 s per DashPal
 *   alert start or level change, its banner and glow. Precedence at the top: DashPal banner, then
 *   the phone's event, then a failed end, then weather; for the glow: a DashPal critical, then the
 *   phone's event, then a DashPal warning or advisory, then speeding.
 * - Top: the weather line, only while an alert covers the area.
 * - Stopped only: the points total and the change since the last stop.
 * - Bottom: hold-to-end in the middle and the navigation button on the right: the only two
 *   controls live at any speed (and, the first time, the navigation button's list of apps, shown in
 *   a panel above them, never a route). Every other touch only undims.
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
  const host = useDriveHost();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const night = useHudNight();
  const p = hudPalette(night);
  const units = useHudUnits();

  const alert = useAlertFlash(live.lastAlert);
  const dashpal = useDashpalFlash();
  const dashpalChip = useDashpalChip();
  const nav = useNavigationButton(useOptionalDb());
  // The button's warm-up highlight: the drive's rows are still under 30 s old (row clock).
  const navWarmupOver = useDrive((s) => s.lastRowTs != null && s.startedAt != null && s.lastRowTs - s.startedAt >= NAV_HIGHLIGHT_MS);
  // The dimmer stays off while either alert shows, and while the list of apps is open.
  const { dimmed, wake } = useDimmer(alert !== null || dashpal !== null || nav.picker !== null);
  // Android back closes the list first (before the drive screen's own swallow).
  const pickerOpen = nav.picker !== null;
  const closePicker = nav.close;
  useEffect(() => {
    if (!pickerOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closePicker();
      return true;
    });
    return () => sub.remove();
  }, [pickerOpen, closePicker]);

  // Where the drive goes once it is over: its summary, fresh, or Home when there was none (a drive
  // that was not kept has no summary; Home says why).
  const droppedId = useDrive((d) => (d.lastFinalized !== null && d.lastFinalized.ok && d.lastFinalized.dropped !== null ? d.lastFinalized.clientTripId : null));
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
      if (done !== null) leave(done.dropped ? null : done.clientTripId);
      else {
        // No drive was open: it ended by itself between the hold and this screen's idle render (the
        // idle effect below is held off by `ending`). Read the store now, not the render's drop id.
        const id = lastTripId.current;
        const f = host.snapshot().lastFinalized;
        leave(id !== null && f !== null && f.ok && f.dropped !== null && f.clientTripId === id ? null : id);
      }
    } catch {
      setEnding(false);
      setEndFailed(true);
    }
  }, [ending, controls, host, leave]);

  // A drive that ends without the button (it ended by itself) still lands on its summary, or on
  // Home when it was not kept.
  const sawRecording = useRef(false);
  useEffect(() => {
    if (live.status === 'recording') sawRecording.current = true;
    else if (live.status === 'idle' && sawRecording.current && !ending) leave(droppedId !== null && droppedId === lastTripId.current ? null : lastTripId.current);
  }, [live.status, ending, leave, droppedId]);

  const speeding = live.speedingTier !== null;
  const dashpalTierNow = dashpal !== null ? dashpalTier(dashpal.tier) : null;
  const glow =
    dashpalTierNow === 'severe'
      ? tierColor(p, 'severe')
      : alert !== null
        ? tierColor(p, alert.tier)
        : dashpalTierNow !== null
          ? tierColor(p, dashpalTierNow)
          : speeding
            ? tierColor(p, live.speedingTier!)
            : null;
  const speedColor = speeding ? tierColor(p, live.speedingTier!) : p.ink;
  const numeral = speedNumeralPt(Math.min(width, height));
  const busy = ending || live.status === 'finalizing';
  const savedApp = nav.saved === null ? null : navAppById(nav.saved);

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
        {dashpalChip !== null ? (
          <View pointerEvents="none" style={[styles.chip, { top: insets.top + 8, right: insets.right + 12 }]}>
            <DashpalChip status={dashpalChip} palette={p} />
          </View>
        ) : null}
        <View style={styles.top}>
          {dashpal !== null ? (
            <DashpalHudBanner visual={dashpal} palette={p} />
          ) : alert !== null ? (
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
          <View style={styles.side} />
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
          <View style={styles.side}>
            <NavigationButton
              caption={savedApp?.short ?? null}
              appLabel={savedApp?.label ?? null}
              highlight={savedApp !== null && live.status === 'recording' && !navWarmupOver}
              disabled={busy || live.status !== 'recording'}
              palette={p}
              onPress={() => void nav.press()}
            />
          </View>
        </View>
      </View>

      {nav.picker !== null ? (
        <View
          testID="hud-nav-panel"
          style={[
            styles.panel,
            {
              top: insets.top + 12,
              left: insets.left + 16,
              right: insets.right + 16,
              // Above the bottom row: End stays reachable while the list is open.
              bottom: insets.bottom + 16 + END_BUTTON_PT + 16,
              backgroundColor: p.chrome,
              borderColor: p.chromeEdge,
            },
          ]}
        >
          <NavAppPicker
            apps={nav.picker.apps}
            mode={nav.picker.mode}
            missingLabel={nav.picker.missingLabel}
            driveLine
            colors={{ surface: p.chrome, ink: p.ink, muted: p.inkMuted, edge: p.chromeEdge }}
            onChoose={(app) => void nav.choose(app)}
            onClose={nav.close}
          />
        </View>
      ) : null}

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
  chip: { position: 'absolute', zIndex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 28 },
  gauges: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 24 },
  bottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  side: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  panel: { position: 'absolute', zIndex: 2, borderRadius: 20, borderWidth: 1, padding: 16 },
  note: { fontFamily: fontFamilies.fieldBold, fontSize: 26, lineHeight: 32 },
});

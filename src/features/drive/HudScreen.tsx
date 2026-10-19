import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DashpalChip, DashpalHudBanner, useDashpalChip, useDashpalFlash, useDashpalHeld } from '@/dashcam/ui/HudDashpal';
import { useOptionalDb } from '@/data/queries/context';
import { useDrive, useDriveControls, useDriveHost, useDriveLive } from '@/drive/useDrive';
import { driveSummaryHref, HOME_HREF } from '@/features/drives/routes';
import { navAppById } from '@/features/navigation/catalog';
import { NavAppPicker } from '@/features/navigation/NavAppPicker';
import { useNavigationButton } from '@/features/navigation/useNavigationButton';
import type { DangerKind } from '@/features/weather/danger';
import { sunIsDown } from '@/lib/time';
import { fontFamilies } from '@/ui/fonts';
import { useOsReduceMotion } from '@/ui/theme';
import {
  DIM_AFTER_MS,
  DIM_SCRIM_OPACITY,
  Halo,
  haloVisual,
  HoldButton,
  hudPalette,
  nextSpeedingHold,
  SPEEDING_HOLD_NONE,
  speedDigits,
  SpeedReadout,
  SpeedSign,
  type BurstSource,
  type SpeedingHold,
} from '@/ui/drive';

import { EventBanner, useAlertFlash } from './EventBanner';
import { hudCopy } from './hudCopy';
import { hudLayout, type Rect } from './hudLayout';
import { navHighlight, NavigationButton } from './NavigationButton';
import { StoppedPoints } from './StoppedPoints';
import { useHaloBurst } from './useHaloBurst';
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
 * - Middle: the halo, a glowing ring with the speed inside it (white when calm, the halo's colour
 *   otherwise). Calm: light blue-white, light moving slowly round it. Over the limit: yellow, then
 *   orange, then red, pulsing faster the further over (held through a speed hovering at the line).
 *   Phone use and a DashPal alert (driver-not-visible included): warmer and faster the more serious
 *   and the longer. A hard brake, hard start, sharp turn, phone pickup or handling alert, and each
 *   DashPal alert start or step (not a reconnect's re-send), pulse it quickly a few times. Rules in `src/ui/drive/halo.ts`; drawing in `HaloRing.tsx`.
 * - Top band: for 1.5 s after an event (or a DashPal alert start or level change) its icon and one
 *   or two words, across the whole band (the DashPal chip steps aside); else a failed end, the
 *   dangerous-weather banner (its ✕ live at any speed; hidden for the rest of the drive once
 *   dismissed), or the points when they have no line of their own. Precedence: DashPal banner, the
 *   phone's event, a failed end, weather, the points. With a DashPal paired, a small static chip top right.
 * - Stopped only: the points total and the change since the last stop, under the halo when there is
 *   room (so the halo never moves), else in the band.
 * - Bottom row: the speed-limit sign (US "SPEED LIMIT" in miles, round red-ringed in kilometres),
 *   hold-to-end in the middle and the navigation button on the right. End, the navigation button
 *   and the weather banner's ✕ are the only touch targets while moving. The navigation button's
 *   list of apps shows in a panel above them, never a route: on the first tap, or on a long press
 *   to change the saved app. Every other touch only undims.
 * - After 10 s without a touch a dark scrim dims everything, never while an alert banner shows; the
 *   halo and the speed stay above it, at reduced strength and still flowing while calm, at full
 *   strength while warning.
 * - Every position comes from `hudLayout` (absolute rects): End is always on screen.
 *
 * It re-renders when `useDriveLive` publishes (≤ 1 Hz), a flash or the dim state flips, or DashPal's
 * held alert changes. The halo moves on the UI thread; under Reduce Motion it only changes colour.
 */
export function HudScreen({ overlay = false }: HudScreenProps) {
  const live = useDriveLive();
  const controls = useDriveControls();
  const host = useDriveHost();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height, fontScale } = useWindowDimensions();
  const reduceMotion = useOsReduceMotion();
  const night = useHudNight();
  const p = hudPalette(night);
  const units = useHudUnits();

  const alert = useAlertFlash(live.lastAlert, live.rowTs);
  const dashpal = useDashpalFlash();
  const dashpalChip = useDashpalChip();
  const held = useDashpalHeld();
  const nav = useNavigationButton(useOptionalDb());
  const savedApp = nav.saved === null ? null : navAppById(nav.saved);
  // The button's warm-up highlight: an app is saved and the drive's rows are still under 30 s old (row clock).
  const navLit = useDrive((s) => s.status === 'recording' && navHighlight(savedApp !== null, s.startedAt, s.lastRowTs));
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
  // that was not kept has no summary; Home says why). Home is the one under the drive: `dismissTo`
  // pops back to the tabs already in the stack (and selects Home), never a second copy of them.
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
      if (clientTripId !== null) router.replace(driveSummaryHref(clientTripId, true));
      else router.dismissTo(HOME_HREF);
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
  const busy = ending || live.status === 'finalizing';
  const recording = live.status === 'recording';

  // The halo: the speeding display hold advances once per new row (React's state-from-the-previous-
  // render pattern; a repeated row returns the same hold, so this settles at once).
  const [hold, setHold] = useState<SpeedingHold>(SPEEDING_HOLD_NONE);
  const nextHold = nextSpeedingHold(hold, { recording, rowTs: live.rowTs, tier: live.speedingTier, speedMph: live.speedMph, limitMph: live.limitMph });
  if (nextHold !== hold) setHold(nextHold);
  const now = wallClock();
  const phoneSource = useMemo<BurstSource | null>(() => (alert === null ? null : { kind: 'phone', type: alert.type, at: alert.at, until: alert.until }), [alert]);
  const dashpalSource = useMemo<BurstSource | null>(
    () => (dashpal === null ? null : { kind: 'dashpal', key: dashpal.key, sound: dashpal.sound, tier: dashpal.tier, resend: dashpal.resend, until: dashpal.until }),
    [dashpal]
  );
  const burst = useHaloBurst({ phone: phoneSource, dashpal: dashpalSource, now });
  const visual = haloVisual({
    reduceMotion,
    status: live.status,
    speeding: nextHold.s,
    phoneUseSince: live.phoneUseSince,
    rowTs: live.rowTs,
    held,
    now,
    burst,
  });

  const layout = hudLayout({ width, height, insets, fontScale, chip: dashpalChip !== null, units });
  const speed = inUnits(live.speedMph, units);
  const numeralPt = speedDigits(speed) >= 3 ? layout.numeralPt3 : layout.numeralPt2;
  const bannerUp = dashpal !== null || alert !== null;
  const showPoints = live.stopped && live.points !== null;
  const pointsView = showPoints ? <StoppedPoints total={live.points!.total} change={live.points!.sinceLastStop} palette={p} /> : null;
  // A weather alert the driver hid (with its ✕, at any speed) stays hidden for the rest of this drive.
  const [hiddenWeather, setHiddenWeather] = useState<{ trip: string | null; kinds: readonly DangerKind[] }>({ trip: null, kinds: [] });
  const weather = live.weatherAlert;
  const weatherShown = weather !== null && !(hiddenWeather.trip === live.clientTripId && hiddenWeather.kinds.includes(weather.kind)) ? weather : null;
  const hideWeather = useCallback(() => {
    if (weather === null) return;
    const trip = live.clientTripId;
    setHiddenWeather((h) => ({ trip, kinds: h.trip === trip ? [...h.kinds, weather.kind] : [weather.kind] }));
  }, [weather, live.clientTripId]);

  return (
    <View testID="hud-screen" onTouchStart={wake} style={[styles.root, { backgroundColor: p.ground }]}>
      {/* The top band: an alert banner across all of it, else the line (and the chip beside it). */}
      <View style={[styles.abs, styles.centred, at(layout.band)]}>
        {dashpal !== null ? (
          <DashpalHudBanner visual={dashpal} palette={p} />
        ) : alert !== null ? (
          <EventBanner alert={alert} palette={p} />
        ) : null}
      </View>
      {!bannerUp ? (
        <View testID="hud-line" style={[styles.abs, styles.centred, at(layout.line)]}>
          {endFailed ? (
            <Text
              testID="hud-end-failed"
              accessibilityRole="alert"
              accessibilityLabel={hudCopy.endFailedLabel}
              allowFontScaling={false}
              numberOfLines={1}
              adjustsFontSizeToFit
              style={[styles.note, { color: p.ink }]}
            >
              {hudCopy.endFailed}
            </Text>
          ) : weatherShown !== null ? (
            <WeatherBanner
              alert={weatherShown}
              units={units}
              palette={p}
              compact={layout.compact}
              onDismiss={hideWeather}
            />
          ) : layout.points === 'line' && pointsView !== null ? (
            pointsView
          ) : null}
        </View>
      ) : null}
      {dashpalChip !== null && layout.chip !== null && !bannerUp ? (
        <View pointerEvents="none" style={[styles.abs, styles.centred, at(layout.chip)]}>
          <DashpalChip status={dashpalChip} palette={p} />
        </View>
      ) : null}

      {/* Twice guarded: the pipeline publishes points only while stopped, and the screen shows
          them only while the car is known to be stopped (a lost fix is not "stopped"). */}
      {layout.points !== 'line' && pointsView !== null ? <View style={[styles.abs, styles.centred, at(layout.points)]}>{pointsView}</View> : null}

      <View style={[styles.abs, styles.centred, at(layout.sign)]}>
        <SpeedSign limit={inUnits(live.limitMph, units)} palette={p} units={units} height={layout.sign.h} />
      </View>
      <View style={[styles.abs, styles.centred, at(layout.end)]}>
        <HoldButton
          testID="hud-end"
          label={busy ? hudCopy.ending : hudCopy.end}
          accessibilityLabel={hudCopy.endLabel}
          accessibilityHint={hudCopy.endHint}
          face={p.chrome}
          ink={p.ink}
          ring={p.ink}
          track={p.chromeEdge}
          size={layout.end.w}
          disabled={busy}
          onHold={() => void onEnd()}
        />
      </View>
      <View style={[styles.abs, styles.centred, at(layout.nav)]}>
        <NavigationButton
          caption={savedApp?.short ?? null}
          appLabel={savedApp?.label ?? null}
          highlight={navLit}
          disabled={busy || live.status !== 'recording'}
          palette={p}
          width={layout.nav.w}
          onPress={() => void nav.press()}
          onLongPress={savedApp !== null ? () => void nav.change() : undefined}
        />
      </View>

      {dimmed ? (
        <View
          testID="hud-dim"
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: p.ground, opacity: DIM_SCRIM_OPACITY }]}
        />
      ) : null}

      {/* Above the scrim: the halo is a safety cue, not decoration. It takes no touch. */}
      <View pointerEvents="none" style={[styles.abs, at(layout.halo)]}>
        <Halo
          visual={visual}
          size={layout.halo.w}
          height={layout.halo.h}
          ring={layout.halo.ring}
          palette={p}
          dimmed={dimmed}
          reduceMotion={reduceMotion}
          numerals={(numeralStyle) => (
            <SpeedReadout
              speed={speed}
              unit={unitLabel(units)}
              color={p.haloInk}
              unitColor={p.haloInkMuted}
              size={numeralPt}
              numeralStyle={numeralStyle}
              speeding={speeding}
            />
          )}
        />
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
              bottom: Math.max(0, height - layout.row.y + 8),
              backgroundColor: p.chrome,
              borderColor: p.chromeEdge,
            },
          ]}
        >
          <NavAppPicker
            apps={nav.picker.apps}
            mode={nav.picker.mode}
            missingLabel={nav.picker.missingLabel}
            selected={nav.picker.mode === 'change' ? nav.saved : null}
            driveLine
            colors={{ surface: p.chrome, ink: p.ink, muted: p.inkMuted, edge: p.chromeEdge }}
            onChoose={(app) => void nav.choose(app)}
            onClose={nav.close}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The JS clock, read at each render on purpose: the DashPal ramp (seconds since an alert began) and
 * a burst's end are judged against it; while recording the screen renders at least once a row.
 */
const wallClock = (): number => Date.now();

/** A layout rect as absolute position and size. */
const at = (r: Rect) => ({ left: r.x, top: r.y, width: r.w, height: r.h });

const styles = StyleSheet.create({
  root: { flex: 1 },
  abs: { position: 'absolute' },
  centred: { alignItems: 'center', justifyContent: 'center' },
  panel: { position: 'absolute', zIndex: 2, borderRadius: 20, borderWidth: 1, padding: 16 },
  note: { fontFamily: fontFamilies.fieldBold, fontSize: 26, lineHeight: 32 },
});

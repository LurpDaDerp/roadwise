import { LinearGradient } from 'expo-linear-gradient';
import * as Location from 'expo-location';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DashpalChip, DashpalHudBanner, useDashpalChip, useDashpalFlash, useDashpalHeld } from '@/dashcam/ui/HudDashpal';
import { useOptionalDb } from '@/data/queries/context';
import { useDrive, useDriveControls, useDriveHost, useDriveLive } from '@/drive/useDrive';
import { driveSummaryHref, HOME_HREF } from '@/features/drives/routes';
import { clearHomeNotice, showHomeNotice } from '@/features/home/homeNotice';
import { navAppById } from '@/features/navigation/catalog';
import { NavAppPicker } from '@/features/navigation/NavAppPicker';
import { useNavigationButton } from '@/features/navigation/useNavigationButton';
import { sunIsDown } from '@/lib/time';
import { mpsToMph } from '@/lib/units';
import { fontFamilies } from '@/ui/fonts';
import { SwipeButton } from '@/ui';
import { useOptionalTheme, useOsReduceMotion } from '@/ui/theme';
import {
  DIM_AFTER_MS,
  DIM_SCRIM_OPACITY,
  Halo,
  haloVisual,
  hudPalette,
  speedingTint,
  SpeedSign,
  type BurstSource,
} from '@/ui/drive';

import { nextEndLock } from './endLock';
import { EventBanner, useAlertFlash } from './EventBanner';
import { hudButtonColors } from './hudButtons';
import { hudCopy } from './hudCopy';
import { hudLayout, type Rect } from './hudLayout';
import { navHighlight, NavigationButton, nextNavLock } from './NavigationButton';
import { NotDrivingLink } from './NotDrivingLink';
import { SpotNudgeLine, useSpotNudgeFlash } from './SpotNudge';
import { useEventShake } from './useEventShake';
import { useHaloBurst } from './useHaloBurst';
import { HaloReadout } from './HaloReadout';
import { inUnits, useHudUnits } from './useHudUnits';
import { WaitingBanner } from './WaitingBanner';
import { WaitPanel } from './WaitPanel';
import { WeatherBanner } from './WeatherBanner';

/** End's swipe forgives this much up or down before it gives way (nothing scrolls under it). */
const END_VERTICAL_SLOP_PT = 24;
/** How often the HUD re-reads the sun (the night palette follows sunset within a few minutes). */
export const HUD_NIGHT_RECHECK_MS = 5 * 60_000;
/** A cached position older than this says little about where the car is now. */
const POSITION_MAX_AGE_MS = 60 * 60_000;

/**
 * Night by the sun at the phone's last known position (the OS's cached fix: no GPS of its own), or
 * null while there is none. Re-checked every few minutes while on screen, and only while `wanted`
 * (a static theme decides day or night itself).
 */
function useSunNight(wanted: boolean): boolean | null {
  const [night, setNight] = useState<boolean | null>(null);
  useEffect(() => {
    if (!wanted) return;
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
  }, [wanted]);
  return night;
}

/**
 * The driving screen's night look: a static theme's own choice (Light: day, Dark: night, System: the
 * phone's scheme); else (Adaptive) the sun at the last known position, and with no position yet the
 * sky's own scheme (dark from dusk to dawn). Outside a theme, the sun or day.
 */
export function hudNightOf(themeNight: boolean | null | undefined, sunNight: boolean | null, skyScheme: 'light' | 'dark' | null): boolean {
  if (themeNight !== null && themeNight !== undefined) return themeNight;
  if (sunNight !== null) return sunNight;
  return skyScheme === 'dark';
}

/**
 * The screen dims after `DIM_AFTER_MS` without a touch; any touch undims it (and re-arms the
 * timer). It never dims while `hold` is true (an alert or a panel is showing). One timer, re-armed
 * per touch; a touch on an undimmed screen changes no state, so it re-renders nothing.
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
 *   otherwise). Calm: light blue-white, light moving slowly round it. Past the posted limit it tints
 *   toward yellow, orange and red with the speed over it (all but calm just over, red at 1.7 × the
 *   limit), following each row; it pulses only while the car is over the speeding line (limit plus
 *   tolerance), faster the further over, and stops on the first row back under it. A DashPal alert
 *   (driver-not-visible included): warmer and faster the more serious and the longer. A hard brake,
 *   hard start or sharp turn, and each DashPal alert start or step (not a reconnect's re-send),
 *   pulse it quickly a few times. Each event (a speeding episode at its grace end too) shakes the
 *   ring sideways once, more for a more serious one. Around it a compass turns with the car's GPS
 *   course (heading up, never growing or moving with the ring). Rules in `src/ui/drive/halo.ts`;
 *   drawing in `HaloRing.tsx` and `HaloCompass.tsx`.
 * - Top row: the speed-limit sign (US "SPEED LIMIT" in miles, round red-ringed in kilometres) on
 *   the left and the navigation button on the right. The navigation button's list of apps shows in
 *   a panel under the row, never a route: on a tap while no app is saved, or on a long press (to
 *   change the saved app, or to pick one). At 35 mph and over the button greys out and takes no
 *   touch (its list closes) until the car is back under 30 mph.
 * - Band, under the top row: for 1.5 s after an event (or a DashPal alert start or level change)
 *   its icon and one or two words, across the whole band (the DashPal chip steps aside); else a
 *   failed end, "Not driving?" when it has no row of its own, for 4 s a problem spot's nudge
 *   ("Watch your speed here"), then the dangerous-weather banner (its ✕ live at any speed; hidden
 *   for the rest of the drive once dismissed). With a DashPal paired, a small static chip top right.
 * - "Not driving?": a small underlined link in its own row above End (landscape: above the
 *   navigation button), shown while the drive's 2-minute budget lasts (the host counts the time this
 *   screen is focused with RoadWise in front); a tap discards the drive and goes Home. A touch that
 *   starts while the screen is dimmed only wakes it.
 * - Waiting (a Start drive swipe, before the car moves): the band says "Ready to roll" · "Starts
 *   once you're moving", the halo shows the wait's own speed, End is "Cancel". At 2:00 a panel asks
 *   "Still planning to drive?", from 4:30 it counts down; any touch waits a fresh 5 minutes; at
 *   5:00, or on Cancel, the wait ends quietly and the screen goes Home.
 * - Landscape: the halo the full height, the sign left of it; on the right the band, the link, the
 *   navigation button and End under it.
 * - Bottom: the End swipe across the screen: the driver swipes its knob right to end the drive. At
 *   15 mph and over it greys out with a lock and takes no swipe, until the car is back under 10.
 *   End and the navigation button wear the app's paper, ink and sky accent (`hudButtonColors`).
 *   End, the navigation button (under 35 mph), "Not driving?" and the weather banner's ✕ are the
 *   only touch targets while moving. Every other touch only undims.
 * - After 10 s without a touch a dark scrim dims everything, never while an alert, a nudge or a
 *   panel shows; the halo and the speed stay above it, at reduced strength and still flowing with no
 *   warning showing (a tint under the speeding line included), at full strength while warning.
 * - Night: a static theme's own look; else the sun at the phone's last known position (with none
 *   yet, the sky's scheme).
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
  const theme = useOptionalTheme();
  const themeNight = theme?.hudNight ?? null;
  const sunNight = useSunNight(themeNight === null);
  const night = hudNightOf(themeNight, sunNight, theme?.scheme ?? null);
  // The hour's sky, deepened for the road (its own day or night set), under everything; its panels
  // take a deeper shade of it. Outside a theme the HUD stays on true black.
  const sky = theme === null ? null : theme.sky.hud[night ? 'night' : 'day'];
  const base = hudPalette(night);
  const p = sky === null ? base : { ...base, ground: sky.stops[1], chrome: sky.chrome, chromeEdge: sky.chromeEdge };
  const b = hudButtonColors(theme, p, night);
  // The list of navigation apps and the waiting panels wear the app's own sheet colours, as in Settings.
  const sheet =
    theme === null
      ? { surface: p.chrome, ink: p.ink, muted: p.inkMuted, edge: p.chromeEdge }
      : { surface: theme.colors.surface, ink: theme.colors.text, muted: theme.colors.textMuted, edge: theme.colors.border };
  const units = useHudUnits();

  // A Start drive swipe waiting for the car to move (no drive yet), or null.
  const waiting = live.waiting;
  const isWaiting = waiting !== null;
  // The speed the locks read: the wait's own GPS speed while waiting, else the newest row's (mph).
  const lockMph = waiting !== null ? (waiting.speedMps === null ? null : Math.round(mpsToMph(waiting.speedMps) * 10) / 10) : live.rowSpeedMph;

  // The screen's focus: the "Not driving?" budget counts only while this screen is focused (the host
  // adds RoadWise being in front), so the lock-screen hint goes at the same moment the link does.
  useFocusEffect(
    useCallback(() => {
      if (overlay) return;
      controls.setHudVisible(true);
      return () => controls.setHudVisible(false);
    }, [controls, overlay])
  );

  const alert = useAlertFlash(live.lastAlert, live.rowTs);
  const nudge = useSpotNudgeFlash(live.spotNudge, live.rowTs);
  const dashpal = useDashpalFlash();
  const dashpalChip = useDashpalChip();
  const held = useDashpalHeld();
  // The navigation button greys out at 35 mph and over, back under 30 (the row's GPS speed; an
  // unknown speed holds it): advanced once per render from the last (state-from-the-previous-render).
  const [navLocked, setNavLocked] = useState(false);
  const nextLocked = nextNavLock(navLocked, lockMph);
  if (nextLocked !== navLocked) setNavLocked(nextLocked);
  // End greys out at 15 mph and over, back under 10 (an unknown speed holds it); never while waiting.
  const [endLocked, setEndLocked] = useState(false);
  const nextEnd = isWaiting ? false : nextEndLock(endLocked, live.rowSpeedMph);
  if (nextEnd !== endLocked) setEndLocked(nextEnd);
  const nav = useNavigationButton(useOptionalDb(), undefined, nextLocked);
  const savedApp = nav.saved === null ? null : navAppById(nav.saved);
  // The button's warm-up highlight: an app is saved and the drive's rows are still under 30 s old (row clock).
  const navLit = useDrive((s) => s.status === 'recording' && navHighlight(savedApp !== null, s.startedAt, s.lastRowTs));
  // The waiting panel: "Still planning to drive?" from 2:00, the countdown from 4:30.
  const waitPanel = waiting !== null && (waiting.phase === 'popup' || waiting.phase === 'countdown') ? { ...waiting, phase: waiting.phase } : null;
  const panelUp = waitPanel !== null;
  // The dimmer stays off while an alert, a nudge, the list of apps or a waiting panel shows.
  const { dimmed, wake } = useDimmer(alert !== null || dashpal !== null || nudge !== null || nav.picker !== null || panelUp);
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
  // A waiting panel closes the list: the two never show together.
  useEffect(() => {
    if (panelUp) closePicker();
  }, [panelUp, closePicker]);

  // Every touch undims; while waiting it also waits a fresh 5 minutes (the panel's Cancel excepted).
  const onTouchStart = useCallback(() => {
    wake();
    if (isWaiting) controls.touchWaiting();
  }, [wake, isWaiting, controls]);

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
  // A failed end says so (one line in the band) until the next swipe.
  const [endFailed, setEndFailed] = useState(false);
  // "Not driving?" is discarding the drive.
  const [cancelling, setCancelling] = useState(false);

  /** Stop the wait (nothing is stored) and go Home, saying nothing. */
  const stopWaiting = useCallback(async () => {
    try {
      await controls.cancelWaiting();
    } catch {
      // The wait ends with the session either way.
    }
    leave(null);
  }, [controls, leave]);

  const onEnd = useCallback(async () => {
    if (ending) return;
    setEnding(true);
    if (isWaiting) {
      // "Cancel": the wait stops.
      await stopWaiting();
      setEnding(false);
      return;
    }
    setEndFailed(false);
    try {
      const done = await controls.end();
      if (done !== null) leave(done.dropped ? null : done.clientTripId);
      else {
        // No drive was open: it ended by itself between the swipe and this screen's idle render (the
        // idle effect below is held off by `ending`). Read the store now, not the render's drop id.
        const id = lastTripId.current;
        const f = host.snapshot().lastFinalized;
        leave(id !== null && f !== null && f.ok && f.dropped !== null && f.clientTripId === id ? null : id);
      }
    } catch {
      setEnding(false);
      setEndFailed(true);
    }
  }, [ending, isWaiting, stopWaiting, controls, host, leave]);

  // "Not driving?": Home is told first (it says the trip won't count as it opens), then the drive is
  // discarded. Refused (its budget ran out between the render and the tap): nothing else happens.
  const onNotDriving = useCallback(async () => {
    if (cancelling) return;
    setCancelling(true);
    if (!overlay) showHomeNotice('notDriving');
    let ok = false;
    try {
      ok = await controls.cancelDrive();
    } catch {
      ok = false;
    }
    if (ok) leave(null);
    else if (!overlay) clearHomeNotice();
    setCancelling(false);
  }, [cancelling, overlay, controls, leave]);

  // A drive that ends without the button (it ended by itself) still lands on its summary, or on
  // Home when it was not kept. One that closed but could not be finalized stays here, saying
  // "Swipe again": End finalizes it again (`host.end()`). A wait that ends with no drive (its 5
  // minutes ran out, or it was cancelled) goes Home, saying nothing.
  const failedId = useDrive((d) => (d.lastFinalized !== null && !d.lastFinalized.ok ? d.lastFinalized.clientTripId : null));
  const sawRecording = useRef(false);
  const sawWaiting = useRef(false);
  useEffect(() => {
    if (live.status === 'recording') sawRecording.current = true;
    if (isWaiting) sawWaiting.current = true;
    if (live.status !== 'idle' || ending || cancelling) return;
    if (sawRecording.current) {
      const id = lastTripId.current;
      if (failedId !== null && failedId === id) setEndFailed(true);
      else leave(droppedId !== null && droppedId === id ? null : id);
    } else if (sawWaiting.current && !isWaiting) leave(null);
  }, [live.status, isWaiting, ending, cancelling, leave, droppedId, failedId]);

  // Over the posted limit speeding is judged on (the speed's spoken label says so).
  const speeding = live.speedingRatio !== null && live.speedingRatio > 1;
  const busy = ending || live.status === 'finalizing';

  // The halo: tinted from the limit on each row, pulsing only over the speeding line; it shakes once
  // for each event as it happens (fresh on the row clock, never one from the background).
  const shake = useEventShake(live.lastShake, live.rowTs);
  const now = wallClock();
  const eventSource = useMemo<BurstSource | null>(() => (alert === null ? null : { kind: 'event', type: alert.type, at: alert.at, until: alert.until }), [alert]);
  const dashpalSource = useMemo<BurstSource | null>(
    () => (dashpal === null ? null : { kind: 'dashpal', key: dashpal.key, sound: dashpal.sound, tier: dashpal.tier, resend: dashpal.resend, until: dashpal.until }),
    [dashpal]
  );
  const burst = useHaloBurst({ event: eventSource, dashpal: dashpalSource, now });
  const visual = haloVisual({
    reduceMotion,
    status: live.status,
    speeding: speedingTint(live.speedingRatio),
    speedingOver: live.speedingOver,
    shake,
    rowTs: live.rowTs,
    held,
    now,
    burst,
  });

  const layout = hudLayout({ width, height, insets, fontScale, chip: dashpalChip !== null, units });
  const compactBand = layout.compact || layout.orientation === 'landscape';
  const bannerUp = dashpal !== null || alert !== null;
  // The weather alert at the car (the host leaves out a kind dismissed this drive); its ✕ hides it
  // for the rest of the drive (a more severe kind shows again).
  const weather = live.weatherAlert;
  const dismissWeather = useCallback(() => controls.dismissWeather(), [controls]);
  // "Not driving?" while the drive's budget lasts; never while waiting, saving or already going.
  const showLink = live.status === 'recording' && live.notDrivingAvailable && !isWaiting && !busy && !cancelling;
  const link = <NotDrivingLink palette={p} dimmed={dimmed} onPress={() => void onNotDriving()} />;

  return (
    <View testID="hud-screen" onTouchStart={onTouchStart} style={[styles.root, { backgroundColor: p.ground }]}>
      {sky !== null ? <LinearGradient testID="hud-sky" pointerEvents="none" colors={sky.stops} style={StyleSheet.absoluteFill} /> : null}
      {/* The band: an alert banner across all of it, else the line (and the chip beside it). */}
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
          ) : isWaiting ? (
            <WaitingBanner palette={p} compact={compactBand} />
          ) : showLink && layout.notDriving === 'line' ? (
            link
          ) : nudge !== null ? (
            <SpotNudgeLine nudge={nudge} palette={p} compact={compactBand} />
          ) : weather !== null ? (
            <WeatherBanner alert={weather} units={units} palette={p} compact={compactBand} onDismiss={dismissWeather} />
          ) : null}
        </View>
      ) : null}
      {dashpalChip !== null && layout.chip !== null && !bannerUp ? (
        <View pointerEvents="none" style={[styles.abs, styles.centred, at(layout.chip)]}>
          <DashpalChip status={dashpalChip} palette={p} />
        </View>
      ) : null}

      <View style={[styles.abs, styles.centred, at(layout.sign)]}>
        <SpeedSign limit={inUnits(waiting !== null ? waiting.limitMph : live.limitMph, units)} palette={p} units={units} height={layout.sign.h} />
      </View>
      {showLink && layout.notDriving !== 'line' ? <View style={[styles.abs, styles.centred, at(layout.notDriving)]}>{link}</View> : null}
      <View style={[styles.abs, styles.centred, at(layout.end)]}>
        <View style={{ width: layout.end.w }}>
          <SwipeButton
            testID="hud-end"
            accessibilityLabel={isWaiting ? hudCopy.cancelLabel : hudCopy.endLabel}
            accessibilityHint={isWaiting ? hudCopy.cancelHint : nextEnd ? hudCopy.endLockedHint(units) : hudCopy.endHint}
            icon={isWaiting ? 'close' : nextEnd ? 'lock-closed' : 'stop'}
            colors={{ track: b.paper, fill: b.fill, knob: b.ink, knobInk: b.paper, hint: b.ink }}
            height={layout.end.h}
            busy={busy}
            disabled={nextEnd}
            verticalSlop={END_VERTICAL_SLOP_PT}
            onSwipe={() => void onEnd()}
            label={
              <Text allowFontScaling={false} numberOfLines={1} adjustsFontSizeToFit style={[styles.endLabel, { color: b.ink }]}>
                {isWaiting ? hudCopy.cancel : busy ? hudCopy.ending : hudCopy.end}
              </Text>
            }
          />
        </View>
      </View>
      <View style={[styles.abs, styles.centred, at(layout.nav)]}>
        <NavigationButton
          caption={savedApp?.short ?? null}
          appLabel={savedApp?.label ?? null}
          highlight={navLit && !nextLocked}
          disabled={busy || (live.status !== 'recording' && !isWaiting)}
          locked={nextLocked}
          units={units}
          palette={p}
          colors={b}
          width={layout.nav.w}
          height={layout.nav.h}
          onPress={() => void nav.press()}
          onLongPress={() => void nav.change()}
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
          heading={live.courseDeg}
          numerals={(numeralStyle) => (
            <HaloReadout
              units={units}
              pt2={layout.numeralPt2}
              pt3={layout.numeralPt3}
              color={p.haloInk}
              unitColor={p.haloInkMuted}
              numeralStyle={numeralStyle}
              speeding={speeding}
              waitingMps={waiting !== null ? waiting.speedMps : undefined}
            />
          )}
        />
      </View>

      {waitPanel !== null ? (
        <View testID="hud-wait" style={[styles.panel, { ...at(layout.panel), backgroundColor: sheet.surface, borderColor: sheet.edge }]}>
          <WaitPanel waiting={waitPanel} colors={sheet} height={layout.panel.h} onKeep={() => controls.touchWaiting()} onCancel={() => void stopWaiting()} />
        </View>
      ) : nav.picker !== null ? (
        <View
          testID="hud-nav-panel"
          style={[
            styles.panel,
            {
              // Never over the navigation button, the link or End: they stay reachable while the list is open.
              ...at(layout.panel),
              backgroundColor: sheet.surface,
              borderColor: sheet.edge,
            },
          ]}
        >
          <NavAppPicker
            apps={nav.picker.apps}
            mode={nav.picker.mode}
            missingLabel={nav.picker.missingLabel}
            selected={nav.picker.mode === 'change' ? nav.saved : null}
            driveLine
            colors={sheet}
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
  endLabel: { fontFamily: fontFamilies.fieldBold, fontSize: 24, lineHeight: 29, letterSpacing: 0.5 },
});

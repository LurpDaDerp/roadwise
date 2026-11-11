import { LinearGradient } from 'expo-linear-gradient';
import * as Location from 'expo-location';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Dimensions, Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DashpalChip, DashpalHudBanner, useDashpalChip, useDashpalFlash, useDashpalHeld } from '@/dashcam/ui/HudDashpal';
import { useOptionalDb } from '@/data/queries/context';
import { rowSpeedMphOf, useBearing, useDrive, useDriveControls, useDriveHost, useDriveLive } from '@/drive/useDrive';
import { driveSummaryHref, HOME_HREF } from '@/features/drives/routes';
import { useEmergencyContacts } from '@/features/emergency/useEmergencyContacts';
import { clearHomeNotice, showHomeNotice } from '@/features/home/homeNotice';
import { navAppById } from '@/features/navigation/catalog';
import { NavAppPicker } from '@/features/navigation/NavAppPicker';
import { NavPlacesPicker } from '@/features/navigation/NavPlacesPicker';
import { useNavigationButton } from '@/features/navigation/useNavigationButton';
import { sunIsDown } from '@/lib/time';
import { fontFamilies } from '@/ui/fonts';
import { SwipeButton } from '@/ui';
import { useOptionalTheme, useOsReduceMotion } from '@/ui/theme';
import {
  DIM_AFTER_MS,
  DIM_SCRIM_OPACITY,
  Halo,
  haloVisual,
  hudPalette,
  SpeedSign,
  type BurstSource,
  type HaloProps,
} from '@/ui/drive';

import { ArrivalOverlay, ARRIVAL_HOLD_MS } from './ArrivalOverlay';
import { BreakReminderLine, useBreakFlash } from './BreakReminder';
import { EmergencyButton } from './EmergencyButton';
import { placeCall } from './emergencyCall';
import { EmergencyPanel } from './EmergencyPanel';
import { nextEndLock } from './endLock';
import { EventBanner, type HudAlert, useAlertFlash } from './EventBanner';
import { hudButtonColors } from './hudButtons';
import { DRIVE_HREF, hudCopy } from './hudCopy';
import { hudLayout, type Rect } from './hudLayout';
import { setDriveScreenFocused } from './hudPresence';
import { navHighlight, NavigationButton, nextNavLock } from './NavigationButton';
import { NotDrivingLink } from './NotDrivingLink';
import { SpotNudgeLine, useSpotNudgeFlash } from './SpotNudge';
import { useEventShake } from './useEventShake';
import { compassHeadingOf, deviceHeadingWanted, nextHeldTrack, useDeviceHeading, type HeldTrack } from './useDeviceHeading';
import { useAppActive, useAppBehind, useHaloBurst } from './useHaloBurst';
import { HaloReadout } from './HaloReadout';
import { inUnits, useHudUnits } from './useHudUnits';
import { WaitPanel } from './WaitPanel';
import { WeatherBanner } from './WeatherBanner';

/** End's swipe forgives this much up or down before it gives way (nothing scrolls under it). */
const END_VERTICAL_SLOP_PT = 24;
/** How often the HUD re-reads the sun (the night palette follows sunset within a few minutes). */
export const HUD_NIGHT_RECHECK_MS = 5 * 60_000;
/** A cached position older than this says little about where the car is now. */
const POSITION_MAX_AGE_MS = 60 * 60_000;
/** The emergency panel closes on its own after this long without a touch. */
export const EMERGENCY_IDLE_MS = 30_000;
/** A screen that opens with no drive (a stale Live Activity tap, Try again after a crash) goes Home after this long. */
export const NO_DRIVE_LEAVE_MS = 2000;

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
 *   otherwise). Calm: light blue-white, light moving slowly round it. Past the limit on the sign it
 *   tints toward yellow, orange and red with the speed shown over it, ever faster: 0 at the limit,
 *   half way at the speeding line (1.16 × the limit − 0.8 mph), full red about 1.47 times the line's
 *   margin over the limit (`speedingTint`), from the first moment the speed passes the sign (on a
 *   wet, snowy or icy road or in fog, the lower limit the road state judges by, and its line); it
 *   pulses only while the car is over the speeding line, faster the further over, and stops on the
 *   first row back under it. A DashPal alert
 *   (driver-not-visible included): warmer and faster the more serious and the longer. A hard brake,
 *   hard start or sharp turn, and each DashPal alert start or step (not a reconnect's re-send),
 *   pulse it quickly a few times. Each event (a speeding episode as it alerts too) shakes the
 *   ring sideways once, more for a more serious one. Around it a compass turns with the car's track
 *   bearing (the engine's, from where the car went; heading up, never growing or moving with the
 *   ring); before the drive's first one, in portrait on iOS, with the phone's own heading, smoothed
 *   (`useDeviceHeading`); once a track bearing has shown, never the phone's again that drive. With
 *   neither (landscape before the first track bearing) it sits north-up, its letters dimmed. Rules
 *   in `src/ui/drive/halo.ts`; drawing in `HaloRing.tsx` and `HaloCompass.tsx`.
 * - Top row: the speed-limit sign (US "SPEED LIMIT" in miles, round red-ringed in kilometres) on
 *   the left with the emergency button under it, and the navigation button on the right. The
 *   navigation button's list of apps shows in a panel under the row, never a route: on a tap while
 *   no app is saved, or on a long press (to change the saved app, or to pick one). With places saved
 *   and a saved app that takes a destination, a tap shows "Where to?" there instead: the places,
 *   each opening directions to it, then the app itself. At 35 mph and over the button greys out and
 *   takes no touch (its list closes) until the car is back under 30 mph.
 * - The emergency button (a red call glyph on the buttons' sky-tinted face, a 64 pt target): always
 *   live, at any speed, dimmed, waiting or saving, and never covered (`hudLayout` keeps every panel
 *   off it, and it draws above the "Welcome" line). A tap opens the emergency panel in the panel
 *   slot, ahead of the waiting panel and the list (which it closes): "Call 911", then the driver's
 *   contacts (`useEmergencyContacts`), then Close. A row's tap hands its number to the phone's call
 *   screen (`placeCall`) and closes the panel. A navigation-button press, Android back and 30 s
 *   without a touch close it too; it holds the dimmer off, and an automatic end waits for it to close.
 * - Arrival: a drive that ends at a saved place (the host's `arrival`, for this drive) darkens the
 *   screen with "Welcome home" (or the place's line) faded in over everything but the emergency
 *   button (`ArrivalOverlay`), and the screen leaves no sooner than 2.5 s after it showed.
 * - Band, under the top row: for 1.5 s after an event (or a DashPal alert start or level change)
 *   its icon and one or two words, across the whole band (the DashPal chip steps aside); while the
 *   car is over the speeding line, "Slow down" in the episode's colour stays up from its alert until
 *   the first row back under the line (another event's chip takes the band for its 1.5 s). A weather
 *   warning (rain, snow, ice or fog lowered the line it warns at; never points) shows the same chip in
 *   its road condition's colour with the condition's icon after the event's, and its "Slow down"
 *   holds the same way while the car is over only the weather line; else a
 *   failed end, "Not driving?" when it has no row of its own, for 4 s a problem spot's nudge
 *   ("Watch your speed here"), for 4 s the break reminder ("Take a break soon" with a cup, at a
 *   stop after 2 h of driving), and the dangerous-weather card where it has no slot of its own.
 *   With a DashPal paired, a small static chip top right.
 * - Weather (portrait): the dangerous-weather card in its own slot under the halo, above End (and
 *   the link's row), kept free whether it shows or not, so nothing moves when it appears: a yellow
 *   outline, the title and what to do ("Warnings come sooner" while the road state moves the
 *   warning lines, when it shows for a wet, snowy or icy road or low visibility too), its ✕ top right (live
 *   at any speed; hidden for the rest of the drive once dismissed). Alerts and nudges never cover it. A window too small for the slot
 *   (landscape, compact, a small phone) shows it in the band's line instead, last.
 *   Where the link lives in the band's line (compact windows), an event or DashPal banner yields to
 *   it while it is offered (the halo's burst and the sound still carry the alert), so no run of
 *   alerts can hide it for its whole budget.
 * - "Not driving?": a small underlined link in its own row above End (landscape: above the
 *   navigation button), shown while the drive's 2-minute budget lasts (the host counts the time this
 *   screen is focused with RoadWise in front; a Start drive's from driving speed); a tap discards the
 *   drive and goes Home. A touch that starts while the screen is dimmed only wakes it.
 * - Presence: while focused with RoadWise in front the screen tells `hudPresence` so (with the
 *   drive's id): the recap notifier and the lockout read it. Blur, the background and unmount say
 *   it is not.
 * - Waiting (a Start drive swipe, until the car reaches driving speed): the drive records from the
 *   tap (its speed, its limit, its halo and alerts); End is "Cancel", the one discard ("Not
 *   driving?" only once the car has reached driving speed, its budget counted from then). At 2:00
 *   a panel asks "Still planning to drive?", from 4:30 it counts down; any touch waits a fresh 5
 *   minutes; at 5:00, or on Cancel, the drive ends
 *   unsaved and the screen goes Home, saying nothing (a Cancel that lands as the car reaches driving
 *   speed stays on the drive).
 * - Landscape: the halo the full height, the sign left of it with the emergency button under it; on
 *   the right the band, the link, the navigation button and End under it.
 * - Bottom: the End swipe across the screen: the driver swipes its knob right to end the drive. At
 *   20 mph and over it greys out with a lock and takes no swipe, until the car is back under 10.
 *   End and the navigation button wear the app's paper, ink and sky accent (`hudButtonColors`).
 *   End, the navigation button (under 35 mph), "Not driving?", the weather banner's ✕, and the
 *   emergency button with its panel are the only touch targets while moving. Every other touch
 *   only undims.
 * - After 10 s without a touch a dark scrim dims everything, never while an alert, a nudge or a
 *   panel (the emergency panel included) shows; the halo and the speed stay above it, at reduced strength and still flowing with no
 *   warning showing (a tint under the speeding line included), at full strength while warning.
 * - Night: a static theme's own look; else the sun at the phone's last known position (with none
 *   yet, the sky's scheme).
 * - Every position comes from `hudLayout` (absolute rects): End is always on screen.
 *
 * It re-renders when `useDriveLive` publishes (once a row, and on a fix only over the limit, where
 * the tint follows each reading), a flash or the dim state flips, or DashPal's held alert changes;
 * with RoadWise in the background the store holds still and it draws nothing. The halo moves on the
 * UI thread; under Reduce Motion it only changes colour.
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
  // Held as the same objects from render to render (a row re-renders the screen), so the memoised
  // parts under it (the compass, the sign, the buttons) and the halo's colour animations stay put.
  const sky = theme === null ? null : theme.sky.hud[night ? 'night' : 'day'];
  const base = hudPalette(night);
  const p = useMemo(() => (sky === null ? base : { ...base, ground: sky.stops[1], chrome: sky.chrome, chromeEdge: sky.chromeEdge }), [base, sky]);
  const b = useMemo(() => hudButtonColors(theme, p, night), [theme, p, night]);
  const endColors = useMemo(() => ({ track: b.paper, fill: b.fill, knob: b.ink, knobInk: b.paper, hint: b.ink }), [b]);
  // The list of navigation apps and the waiting panels wear the app's own sheet colours, as in Settings.
  const sheet = useMemo(
    () =>
      theme === null
        ? { surface: p.chrome, ink: p.ink, muted: p.inkMuted, edge: p.chromeEdge, accent: p.haloCalm }
        : {
            surface: theme.colors.surface,
            ink: theme.colors.text,
            muted: theme.colors.textMuted,
            edge: theme.colors.border,
            raised: theme.colors.surfaceRaised,
            accent: theme.colors.accent,
            accentFaint: theme.colors.accentFaint,
          },
    [theme, p]
  );
  const units = useHudUnits();
  const { contacts } = useEmergencyContacts();

  // A Start-card drive still waiting for driving speed (it records from the tap), or null.
  const waiting = live.waiting;
  const isWaiting = waiting !== null;
  // The speed the locks read: the newest row's (mph).
  const lockMph = live.rowSpeedMph;

  // The screen's focus: the "Not driving?" budget counts only while this screen is focused (the host
  // adds RoadWise being in front), so the lock-screen hint goes at the same moment the link does.
  const [focused, setFocused] = useState(false);
  // The same focus as it is this instant, for the way out (`leave`), which may run outside a render.
  const focusedNow = useRef(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      focusedNow.current = true;
      if (!overlay) controls.setHudVisible(true);
      return () => {
        setFocused(false);
        focusedNow.current = false;
        if (!overlay) controls.setHudVisible(false);
      };
    }, [controls, overlay])
  );
  // Still in the stack: a way out that lands after the screen has gone has no route of its own to return to.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Presence (`hudPresence`): focused with RoadWise in front, for the open drive. Not for the
  // diagnostics simulation, which is never the driving screen.
  const appActive = useAppActive();
  // In the background, not merely covered: Control Center or a call banner over the screen keeps
  // the compass on the phone's heading (`inactive` is still in front).
  const behind = useAppBehind();
  const present = !overlay && focused && appActive;
  const presenceTripId = live.clientTripId;
  const [presenceOwner] = useState(() => ({}));
  useEffect(() => {
    reportPresence(presenceOwner, present, presenceTripId);
  }, [presenceOwner, present, presenceTripId]);
  useEffect(() => () => reportPresence(presenceOwner, false, null), [presenceOwner]);

  const alert = useAlertFlash(live.lastAlert, live.rowTs);
  // "Slow down" holds while the car is over the speeding line, in the episode's colour as it is now;
  // over only the weather line, it holds as the weather warning (the road condition's colour and
  // icon). A fresh alert (another event's, or speeding's own) takes the chip for its flash. Only the
  // flash bursts the halo.
  const speedingTier = live.speedingTier;
  const speedingWeather = live.speedingWeather;
  const speedingHeld = useMemo<HudAlert | null>(
    () =>
      speedingTier !== null
        ? { type: 'speeding', tier: speedingTier, at: 0 }
        : speedingWeather !== null
          ? { type: 'speeding', tier: 'minor', at: 0, road: speedingWeather }
          : null,
    [speedingTier, speedingWeather]
  );
  const chip = alert ?? speedingHeld;
  const nudge = useSpotNudgeFlash(live.spotNudge, live.rowTs);
  const breakShown = useBreakFlash(live.breakReminder, live.rowTs);
  const dashpal = useDashpalFlash();
  const dashpalChip = useDashpalChip();
  const held = useDashpalHeld();
  // The navigation button greys out at 35 mph and over, back under 30 (the row's GPS speed; an
  // unknown speed holds it): advanced once per render from the last (state-from-the-previous-render).
  const [navLocked, setNavLocked] = useState(false);
  const nextLocked = nextNavLock(navLocked, lockMph);
  if (nextLocked !== navLocked) setNavLocked(nextLocked);
  // End greys out at 20 mph and over, back under 10 (an unknown speed holds it); never while waiting.
  const [endLocked, setEndLocked] = useState(false);
  const nextEnd = isWaiting ? false : nextEndLock(endLocked, live.rowSpeedMph);
  if (nextEnd !== endLocked) setEndLocked(nextEnd);
  // With RoadWise in the background the store holds still (`src/drive/store.ts`), so this screen sees
  // no rows. Both locks are advanced over every state the host publishes meanwhile, and taken up on
  // the way back before the screen is drawn, so a dip under 10 mph that happened only while the phone
  // was locked still frees End, as it would have on screen.
  const locks = useRef({ end: nextEnd, nav: nextLocked });
  useLayoutEffect(() => {
    locks.current = { end: nextEnd, nav: nextLocked };
  });
  useLayoutEffect(() => {
    if (!behind) return;
    let { end, nav: navLock } = locks.current;
    const off = host.subscribe((s) => {
      const mph = rowSpeedMphOf(s);
      end = s.waiting !== null ? false : nextEndLock(end, mph);
      navLock = nextNavLock(navLock, mph);
    });
    return () => {
      off();
      setEndLocked(end);
      setNavLocked(navLock);
    };
  }, [behind, host]);
  const nav = useNavigationButton(useOptionalDb(), undefined, nextLocked);
  const savedApp = nav.saved === null ? null : navAppById(nav.saved);
  // The button's warm-up highlight: an app is saved and the drive's rows are still under 30 s old (row clock).
  const navLit = useDrive((s) => s.status === 'recording' && navHighlight(savedApp !== null, s.startedAt, s.lastRowTs));
  // The waiting panel: "Still planning to drive?" from 2:00, the countdown from 4:30.
  const waitPanel = waiting !== null && (waiting.phase === 'popup' || waiting.phase === 'countdown') ? { ...waiting, phase: waiting.phase } : null;
  const panelUp = waitPanel !== null;
  // The emergency panel: opened by the emergency button, closed by its Close, a call, a
  // navigation-button press, Android back, or 30 s without a touch on the screen.
  const [sosOpen, setSosOpen] = useState(false);
  const sosTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armSos = useCallback(() => {
    if (sosTimer.current !== null) clearTimeout(sosTimer.current);
    sosTimer.current = setTimeout(() => {
      sosTimer.current = null;
      setSosOpen(false);
    }, EMERGENCY_IDLE_MS);
  }, []);
  const closeSos = useCallback(() => {
    if (sosTimer.current !== null) clearTimeout(sosTimer.current);
    sosTimer.current = null;
    setSosOpen(false);
  }, []);
  useEffect(
    () => () => {
      if (sosTimer.current !== null) clearTimeout(sosTimer.current);
    },
    []
  );
  // The dimmer stays off while an alert, a nudge, the break reminder, the list of apps, a waiting panel or the emergency panel shows.
  const { dimmed, wake } = useDimmer(chip !== null || dashpal !== null || nudge !== null || breakShown !== null || nav.picker !== null || panelUp || sosOpen);
  // Android back closes the list first (before the drive screen's own swallow).
  const pickerOpen = nav.picker !== null;
  const closePicker = nav.close;
  // The emergency button opens its panel (a second tap keeps it open), closing the list.
  const openSos = useCallback(() => {
    setSosOpen(true);
    armSos();
    closePicker();
  }, [armSos, closePicker]);
  // A call hands the number to the phone and closes the panel; one that didn't start keeps it open.
  const callSos = useCallback(
    async (phone: string) => {
      const ok = await placeCall(phone);
      if (ok) closeSos();
      return ok;
    },
    [closeSos]
  );
  useEffect(() => {
    if (!sosOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeSos();
      return true;
    });
    return () => sub.remove();
  }, [sosOpen, closeSos]);
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

  // Every touch undims; while waiting it also waits a fresh 5 minutes (the panel's Cancel excepted);
  // with the emergency panel open it gives the panel a fresh 30 s.
  const onTouchStart = useCallback(() => {
    wake();
    if (isWaiting) controls.touchWaiting();
    if (sosTimer.current !== null) armSos();
  }, [wake, isWaiting, controls, armSos]);

  // Where the drive goes once it is over: its summary, fresh, or Home when there was none (a drive
  // that was not kept has no summary; Home says why). Home is the one under the drive: `dismissTo`
  // pops back to the tabs already in the stack (and selects Home), never a second copy of them.
  // With another route over this screen (it is not the focused one), the stack first pops back to
  // this screen, so the summary takes this screen's place and never the place of the route over it.
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
      if (mounted.current && !focusedNow.current) router.dismissTo(DRIVE_HREF);
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

  // The drive ended at a saved place (the host's `arrival` for this drive): the "Welcome" line shows
  // (never again for a drive whose end failed, which needs End again, retries included) and the
  // screen's way out waits until it has shown for 2.5 s.
  const arrival = useDrive((d) => d.arrival);
  // The drive this screen showed last (it stays the same through finalizing and idle), advanced once
  // per render as the locks are.
  const [shownTripId, setShownTripId] = useState(live.clientTripId);
  if (live.clientTripId !== null && live.clientTripId !== shownTripId) setShownTripId(live.clientTripId);
  const thisTripId = live.clientTripId ?? shownTripId;
  const [failedTripId, setFailedTripId] = useState<string | null>(null);
  if (endFailed && thisTripId !== null && thisTripId !== failedTripId) setFailedTripId(thisTripId);
  const arrived = arrival !== null && arrival.clientTripId === thisTripId && !endFailed && thisTripId !== failedTripId ? arrival : null;
  const arrivalId = arrived?.clientTripId ?? null;
  const [arrivalShown, setArrivalShown] = useState<string | null>(null);
  useEffect(() => {
    if (arrivalId === null) return;
    const timer = setTimeout(() => setArrivalShown(arrivalId), ARRIVAL_HOLD_MS);
    return () => clearTimeout(timer);
  }, [arrivalId]);
  const arrivalHolding = arrivalId !== null && arrivalShown !== arrivalId;

  /**
   * Stop the wait (nothing is stored) and go Home, saying nothing. The car reached driving speed as
   * Cancel landed (the host no longer waits, so nothing was cancelled): the drive goes on here, End
   * is End again.
   */
  const stopWaiting = useCallback(async () => {
    try {
      await controls.cancelWaiting();
    } catch {
      // The wait ends with the session either way.
    }
    const s = host.snapshot();
    if (s.status === 'recording' && s.waiting === null) return;
    leave(null);
  }, [controls, host, leave]);

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
  // minutes ran out, or it was cancelled) goes Home, saying nothing. A screen first shown while the
  // drive is being saved takes the same way out once it is saved.
  const failedId = useDrive((d) => (d.lastFinalized !== null && !d.lastFinalized.ok ? d.lastFinalized.clientTripId : null));
  // Whether this screen has seen the drive open or waiting (advanced once per render, as the locks are).
  const [sawBusy, setSawBusy] = useState(live.status !== 'idle');
  if (live.status !== 'idle' && !sawBusy) setSawBusy(true);
  const [sawWaiting, setSawWaiting] = useState(isWaiting);
  if (isWaiting && !sawWaiting) setSawWaiting(true);
  // The way out also waits while the "Welcome" line holds, and while the emergency panel is open (it
  // closes by itself within 30 s), so an automatic end never takes the panel away.
  useEffect(() => {
    if (live.status !== 'idle' || ending || cancelling || arrivalHolding || sosOpen) return;
    if (sawBusy) {
      const id = lastTripId.current;
      if (failedId !== null && failedId === id) setEndFailed(true);
      else leave(droppedId !== null && droppedId === id ? null : id);
    } else if (sawWaiting && !isWaiting) leave(null);
  }, [live.status, isWaiting, sawBusy, sawWaiting, ending, cancelling, arrivalHolding, sosOpen, leave, droppedId, failedId]);
  // Opened with no drive at all (and no failed end to swipe again): Home after a short grace, which
  // covers a Start or a launch that is still opening the drive.
  const noDrive = live.status === 'idle' && !isWaiting && !sawBusy && !sawWaiting && failedId === null && !ending && !cancelling && !sosOpen;
  useEffect(() => {
    if (!noDrive) return;
    const timer = setTimeout(() => leave(null), NO_DRIVE_LEAVE_MS);
    return () => clearTimeout(timer);
  }, [noDrive, leave]);

  // Over the limit the sign shows (the speed's spoken label says so).
  const speeding = live.overSign;
  const busy = ending || live.status === 'finalizing';

  // The halo: tinted from the sign's limit up (the limit the weather lowered, on such a road), pulsing
  // only over the speeding line (or the weather line, while its "Slow down" holds); it shakes once for each event as it happens (fresh on the row clock,
  // never one from the background).
  const shake = useEventShake(live.lastShake, live.rowTs);
  const now = wallClock();
  // The compass: the drive's track bearing, held for the rest of the drive once shown (advanced once
  // per render from the last, as the locks are); before it the phone's heading (see `HudHalo`).
  const bearing = useBearing();
  const track = bearing.source === 'track' ? bearing.deg : null;
  const [heldTrack, setHeldTrack] = useState<HeldTrack | null>(null);
  const nextTrack = nextHeldTrack(heldTrack, track, live.clientTripId);
  if (nextTrack !== heldTrack) setHeldTrack(nextTrack);
  const eventSource = useMemo<BurstSource | null>(() => (alert === null ? null : { kind: 'event', type: alert.type, at: alert.at, until: alert.until }), [alert]);
  const dashpalSource = useMemo<BurstSource | null>(
    () => (dashpal === null ? null : { kind: 'dashpal', key: dashpal.key, sound: dashpal.sound, tier: dashpal.tier, resend: dashpal.resend, until: dashpal.until }),
    [dashpal]
  );
  const burst = useHaloBurst({ event: eventSource, dashpal: dashpalSource, now });
  const visual = haloVisual({
    reduceMotion,
    status: live.status,
    speeding: live.speedingTint,
    speedingOver: live.speedingOver,
    shake,
    rowTs: live.rowTs,
    held,
    now,
    burst,
  });

  const layout = hudLayout({ width, height, insets, fontScale, chip: dashpalChip !== null, units });
  const compactBand = layout.compact || layout.orientation === 'landscape';
  // "Not driving?" while the drive's budget lasts; never while a Start-card drive waits (Cancel is its
  // discard then), while saving or already going.
  const showLink = live.status === 'recording' && !isWaiting && live.notDrivingAvailable && !busy && !cancelling;
  // The link in the band's line (a failed end keeps the line first): an alert banner yields to it, so
  // a run of alerts can never hide it for its whole budget. The halo still bursts and the sound plays.
  const linkInLine = showLink && layout.notDriving === 'line' && !endFailed;
  const bannerUp = (dashpal !== null || chip !== null) && !linkInLine;
  // The weather card: the alert at the car (the host leaves out a kind dismissed this drive), and the
  // road state while it moves the warning lines; its ✕ hides it for the rest of the drive (a more severe
  // kind, or a stricter road, shows again). In its own slot under the halo where the window has one,
  // else in the band's line.
  const weather = live.weatherAlert;
  const road = live.weatherRoad ?? null;
  const cardUp = weather !== null || road !== null;
  const dismissWeather = useCallback(() => controls.dismissWeather(), [controls]);
  const weatherSlot = layout.weather === 'line' ? null : layout.weather;
  // Stable handlers, so the memoised link and buttons (and End's swipe gesture) are not rebuilt per row.
  const pressNotDriving = useCallback(() => void onNotDriving(), [onNotDriving]);
  const swipeEnd = useCallback(() => void onEnd(), [onEnd]);
  const { press: navPress, change: navChange } = nav;
  // A navigation-button press closes the emergency panel.
  const pressNav = useCallback(() => {
    closeSos();
    void navPress();
  }, [closeSos, navPress]);
  const longPressNav = useCallback(() => {
    closeSos();
    void navChange();
  }, [closeSos, navChange]);
  const link = <NotDrivingLink palette={p} dimmed={dimmed} onPress={pressNotDriving} />;

  return (
    <View testID="hud-screen" onTouchStart={onTouchStart} style={[styles.root, { backgroundColor: p.ground }]}>
      {sky !== null ? <LinearGradient testID="hud-sky" pointerEvents="none" colors={sky.stops} style={StyleSheet.absoluteFill} /> : null}
      {/* The band: an alert banner across all of it, else the line (and the chip beside it). */}
      <View style={[styles.abs, styles.centred, at(layout.band)]}>
        {!bannerUp ? null : dashpal !== null ? (
          <DashpalHudBanner visual={dashpal} palette={p} />
        ) : chip !== null ? (
          <EventBanner alert={chip} palette={p} />
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
          ) : linkInLine ? (
            link
          ) : nudge !== null ? (
            <SpotNudgeLine nudge={nudge} palette={p} compact={compactBand} />
          ) : breakShown !== null ? (
            <BreakReminderLine palette={p} compact={compactBand} />
          ) : cardUp && weatherSlot === null ? (
            <WeatherBanner alert={weather} road={road} units={units} palette={p} compact={compactBand} onDismiss={dismissWeather} />
          ) : null}
        </View>
      ) : null}
      {cardUp && weatherSlot !== null ? (
        <View testID="hud-weather-slot" style={[styles.abs, styles.slot, at(weatherSlot)]}>
          <WeatherBanner alert={weather} road={road} units={units} palette={p} compact={false} onDismiss={dismissWeather} />
        </View>
      ) : null}
      {dashpalChip !== null && layout.chip !== null && !bannerUp ? (
        <View pointerEvents="none" style={[styles.abs, styles.centred, at(layout.chip)]}>
          <DashpalChip status={dashpalChip} palette={p} />
        </View>
      ) : null}

      <View style={[styles.abs, styles.centred, at(layout.sign)]}>
        {/* The drive's own limit, the Live Activity's (a Start-card drive's too: it records from the tap). */}
        <SpeedSign limit={inUnits(live.limitMph, units)} palette={p} units={units} height={layout.sign.h} />
      </View>
      {showLink && layout.notDriving !== 'line' ? <View style={[styles.abs, styles.centred, at(layout.notDriving)]}>{link}</View> : null}
      <View testID="hud-end-slot" style={[styles.abs, styles.centred, at(layout.end)]}>
        <View style={{ width: layout.end.w }}>
          <SwipeButton
            testID="hud-end"
            accessibilityLabel={isWaiting ? hudCopy.cancelLabel : hudCopy.endLabel}
            accessibilityHint={isWaiting ? hudCopy.cancelHint : nextEnd ? hudCopy.endLockedHint(units) : hudCopy.endHint}
            icon={isWaiting ? 'close' : nextEnd ? 'lock-closed' : 'stop'}
            colors={endColors}
            height={layout.end.h}
            busy={busy}
            disabled={nextEnd}
            verticalSlop={END_VERTICAL_SLOP_PT}
            onSwipe={swipeEnd}
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
          places={nav.hasPlaces}
          disabled={busy || (live.status !== 'recording' && !isWaiting)}
          locked={nextLocked}
          units={units}
          palette={p}
          colors={b}
          width={layout.nav.w}
          height={layout.nav.h}
          onPress={pressNav}
          onLongPress={longPressNav}
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
      <View testID="hud-halo-slot" pointerEvents="none" style={[styles.abs, at(layout.halo)]}>
        <HudHalo
          track={nextTrack}
          deviceWanted={deviceHeadingWanted({
            ios: Platform.OS === 'ios',
            focused,
            active: !behind,
            recording: live.status === 'recording',
            ring: layout.halo.ring,
            portrait: portraitNow(width, height),
            hasTrack: nextTrack !== null,
          })}
          visual={visual}
          size={layout.halo.w}
          height={layout.halo.h}
          ring={layout.halo.ring}
          palette={p}
          dimmed={dimmed}
          reduceMotion={reduceMotion}
          numerals={(numeralStyle) => (
            <HaloReadout
              units={units}
              pt2={layout.numeralPt2}
              pt3={layout.numeralPt3}
              color={p.haloInk}
              unitColor={p.haloInkMuted}
              numeralStyle={numeralStyle}
              speeding={speeding}
            />
          )}
        />
      </View>

      {sosOpen ? (
        <View testID="hud-sos-sheet" style={[styles.panel, styles.sosPanel, { ...at(layout.sosPanel), backgroundColor: sheet.surface, borderColor: sheet.edge }]}>
          <EmergencyPanel contacts={contacts} palette={p} colors={sheet} height={layout.sosPanel.h} onCall={callSos} onClose={closeSos} />
        </View>
      ) : waitPanel !== null ? (
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
          {nav.picker.mode === 'places' ? (
            <NavPlacesPicker
              app={nav.picker.app}
              places={nav.picker.places}
              colors={sheet}
              onGo={(place) => void nav.goTo(place)}
              onOpenApp={() => void nav.openApp()}
              onClose={nav.close}
            />
          ) : (
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
          )}
        </View>
      ) : null}

      {/* Over everything but the emergency button and its panel. */}
      {arrived !== null ? <ArrivalOverlay arrival={arrived} palette={p} reduceMotion={reduceMotion} /> : null}

      {/* Drawn last: nothing covers it or takes its touches. */}
      <View style={[styles.abs, styles.centred, styles.sos, at(layout.sos)]}>
        <EmergencyButton palette={p} colors={b} open={sosOpen} onPress={openSos} />
      </View>
    </View>
  );
}

/**
 * The driving screens present now (focused with RoadWise in front), each with its drive's id. Two
 * can overlap for a moment (one opening as the other goes), so the screen that goes never clears
 * the presence the other one holds.
 */
const presentScreens = new Map<object, string | null>();

function reportPresence(owner: object, present: boolean, tripId: string | null): void {
  if (present) presentScreens.set(owner, tripId);
  else if (!presentScreens.delete(owner)) return;
  const others = [...presentScreens.values()];
  setDriveScreenFocused(others.length > 0, present ? tripId : (others.at(-1) ?? null));
}

/**
 * The halo with its compass's heading: the held track bearing, else (while `deviceWanted`) the
 * phone's own heading. Its own component, so a turning phone re-renders the halo alone.
 */
function HudHalo({ track, deviceWanted, ...halo }: Omit<HaloProps, 'heading'> & { track: HeldTrack | null; deviceWanted: boolean }) {
  const device = useDeviceHeading(deviceWanted);
  return <Halo {...halo} heading={compassHeadingOf(track, device)} />;
}

/**
 * Portrait, as the phone's compass is measured: the window taller than wide, and the screen too (a
 * narrow split-screen window on a landscape iPad is not portrait).
 */
function portraitNow(width: number, height: number): boolean {
  const screen = Dimensions.get('screen');
  return width < height && screen.width < screen.height;
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
  slot: { justifyContent: 'center' },
  panel: { position: 'absolute', zIndex: 2, borderRadius: 28, borderCurve: 'continuous', borderWidth: 1, padding: 16, boxShadow: '0px 12px 32px rgba(0, 0, 0, 0.28)' },
  // The emergency panel and button sit above the "Welcome" line (zIndex 3).
  sosPanel: { zIndex: 4 },
  sos: { zIndex: 5 },
  note: { fontFamily: fontFamilies.fieldBold, fontSize: 26, lineHeight: 32 },
  endLabel: { fontFamily: fontFamilies.fieldBold, fontSize: 24, lineHeight: 29, letterSpacing: 0.5 },
});

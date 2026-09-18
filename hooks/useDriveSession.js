// useDriveSession — the drive engine, extracted from the old DriveScreen.
//
// Owns: the GPS watch, speed and distance, speed-limit lookup (cache + HERE),
// hard brake / acceleration detection, weather + road summary, the points
// timer, phone-use distraction (AppState), spoken limit changes, the speeding
// alert, and finalization (drive record, streak, points).
//
// Behaviour preserved from the original screen:
//   • +1 point every 2.5 s while moving (> 10 mph) and ≤ 125 % of the limit;
//     the delay grows with the margin over the limit, nothing above 150 %.
//   • Speeding = rounded speed > 125 % of the limit, sustained 2.5 s before the alert.
//   • Phone use: leaving the app for > 5 s after the drive has started = distracted
//     (points stop for the rest of the drive, streak resets); 2 min away = drive ends.
//   • Drive record only saved when points > 0.
//
// `getFinalizeExtra` may be async (the drive screen awaits the monitoring engine's final
// snapshot in it); both the hold-to-end and the auto-end path await it.
//
// New: [MP-4] monitoring metrics stored in the record, [MP-5] `pausePoints`
// suspends the timer while a CRITICAL monitoring alert is active, top speed and
// real phone-usage seconds are recorded, a per-drive score is computed.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { speak, stopSpeech, SPEECH_PRIORITY } from '../utils/speech';
import { auth } from '../utils/firebase';
import { finalizeDriveWrite, flushPendingDriveWrites, getPendingDriveCount, invalidateDriveCounts, startDriving, stopDriving } from '../utils/firestore';
import { scheduleDistractedNotification, scheduleFirstDistractedNotification } from '../utils/notifications';
import { fetchWeather } from '../utils/weather';
import { getRoadConditionSummary } from '../utils/gptApi';
import { invalidateInsightsCache } from '../utils/driveCache';
import { invalidateLeaderboard } from '../utils/leaderboard';
import {
  loadSpeedLimitCache,
  flushSpeedLimitCache,
  lookupCachedSpeedLimit,
  getSpeedLimit,
  fillCachePolyline,
  toDisplayUnits,
  haversineM,
  bearingDeg,
  distanceMeters,
} from '../utils/speedLimits';
import { isRoadSlippery, hasSignificantChange, localRoadSummary, getWeatherInfo } from '../utils/driveConditions';
import { scoreDrive } from '../utils/driveScore';
import { speedFromMps } from '../utils/format';
import { buildMonitoringRecord, monitoringVerdict } from '../monitoring/summary';
import { ALERT_SEVERITY } from '../monitoring/types';

const DEFAULT_SPEED_LIMIT_MPH = 25;
const DEFAULT_DELAY = 2500;
const ACCEL_THRESHOLD = 3.0; // m/s²
const BRAKE_THRESHOLD = -3.0;
const SPEEDING_GRACE_MS = 2500;
const PHONE_GRACE_MS = 5000;
const AUTO_END_MS = 2 * 60 * 1000;
// Polyline back-fill geometry (the cache itself lives in utils/speedLimits).
const MIN_SEG_TO_FILL_M = 120;
const HEADING_TOL_DEG = 20;
const MAX_SEG_LEN_M = 4000;
// Weather: conditions do not change on a 10 s / 100 m timescale, and each poll can
// trigger an OpenAI road-condition summary.
const WEATHER_MIN_INTERVAL_S = 300;
const WEATHER_MIN_DISTANCE_M = 1000;
// A fix older than this is "no signal": the speed display and the monitoring speed gate must
// not keep believing the last one (docs/dms/DETECTION_DESIGN.md §8 uses the same 10 s).
const FIX_STALE_MS = 10_000;
const FIX_STALE_CHECK_MS = 5_000;

export function useDriveSession({
  active = true,
  unit = 'mph',
  showSpeedLimit = true,
  audioSpeedUpdatesEnabled = true,
  speedingWarningsEnabled = true,
  distractedNotificationsEnabled = true,
  notifyDriveComplete = true,
  pausePoints = false,
  onAutoEnd,
  getFinalizeExtra, // () => extra (may be a promise) merged into finalize() on auto-end ([MP-4] survives the 2-minute timeout)
} = {}) {

  // ---- render state -------------------------------------------------------
  const [rawSpeedMps, setRawSpeedMps] = useState(0);
  const [limitKph, setLimitKph] = useState(null);
  const [limitSource, setLimitSource] = useState('default'); // 'default' | 'cache' | 'fetched'
  const [points, setPoints] = useState(0);
  // The elapsed seconds are NOT state here: a 1 Hz setState re-rendered the whole drive screen
  // (speed hero, points card, conditions strip, emergency sheet) to move one clock. The screen
  // gets `startedAt` and ticks the clock inside the leaf that shows it.
  const [lastFixAt, setLastFixAt] = useState(null);
  const [phone, setPhone] = useState({ pickups: 0, distracted: false, awayNow: false });
  const [weather, setWeather] = useState(null);
  const [roadSummary, setRoadSummary] = useState(null);
  const [gpsStatus, setGpsStatus] = useState('searching'); // 'searching' | 'ok' | 'denied' | 'error'
  const [pendingDrives, setPendingDrives] = useState(0); // finished drives waiting to upload
  const [isSpeeding, setIsSpeeding] = useState(false);
  const [speedingAlertOn, setSpeedingAlertOn] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);

  // ---- refs (accumulators, never cause renders) ---------------------------
  const startTime = useRef(Date.now());
  const speedRef = useRef(0);            // display units
  const rawSpeedRef = useRef(0);         // m/s
  const limitKphRef = useRef(null);
  const unitRef = useRef(unit);
  const pointsRef = useRef(0);
  const pausePointsRef = useRef(pausePoints);
  const hasStartedRef = useRef(false);
  const isDistractedRef = useRef(false);
  const pickupsRef = useRef(0);
  const phoneUsageSecRef = useRef(0);
  const appActiveRef = useRef(AppState.currentState === 'active');
  const unfocusedAt = useRef(null);
  const backgroundTimeout = useRef(null);
  const firstNotificationId = useRef(null);
  const finalizedRef = useRef(false);
  const locationSub = useRef(null);
  const pointTimer = useRef(null);
  const lastLocation = useRef(null);
  const lastFixAtRef = useRef(null);
  const totalDistance = useRef(0);
  const maxSpeedRef = useRef(0);
  const totalSpeedSum = useRef(0);
  const speedSampleCount = useRef(0);
  const speedingMarginSum = useRef(0);
  const speedingSampleCount = useRef(0);
  const speedingEvents = useRef(0);
  const wasSpeedingRef = useRef(false);
  const suddenStops = useRef(0);
  const suddenAccels = useRef(0);
  const lastSpeedMS = useRef(null);
  const lastAccelTime = useRef(Date.now());
  const lastWeatherFetch = useRef(0);
  const lastWeatherCoords = useRef(null);
  const lastWeatherMetrics = useRef(null);
  const weatherRef = useRef(null);
  const roadSummaryRef = useRef(null);
  const currentSeg = useRef([]);
  const segHeading = useRef(null);
  const prevFetchedLimit = useRef(null);
  const prevFetchedStreet = useRef(null);
  const speedingTimeout = useRef(null);
  const prevSpokenLimit = useRef(null);
  const showSpeedLimitRef = useRef(showSpeedLimit);
  const onAutoEndRef = useRef(onAutoEnd);
  const getFinalizeExtraRef = useRef(getFinalizeExtra);
  const settingsRef = useRef({ distractedNotificationsEnabled, notifyDriveComplete, speedingWarningsEnabled });

  useEffect(() => { unitRef.current = unit; }, [unit]);
  useEffect(() => { pausePointsRef.current = pausePoints; }, [pausePoints]);
  useEffect(() => { showSpeedLimitRef.current = showSpeedLimit; }, [showSpeedLimit]);
  useEffect(() => { onAutoEndRef.current = onAutoEnd; }, [onAutoEnd]);
  useEffect(() => { getFinalizeExtraRef.current = getFinalizeExtra; }, [getFinalizeExtra]);
  useEffect(() => {
    settingsRef.current = { distractedNotificationsEnabled, notifyDriveComplete, speedingWarningsEnabled };
  }, [distractedNotificationsEnabled, notifyDriveComplete, speedingWarningsEnabled]);
  useEffect(() => { weatherRef.current = weather; }, [weather]);
  useEffect(() => { roadSummaryRef.current = roadSummary; }, [roadSummary]);

  const defaultLimitKph = DEFAULT_SPEED_LIMIT_MPH * 1.60934;
  const effectiveLimitKph = () => limitKphRef.current ?? defaultLimitKph;
  const limitInUnit = () => toDisplayUnits(effectiveLimitKph(), unitRef.current);

  // ---- pending uploads: retry at drive start, show what is still waiting -----
  useEffect(() => {
    if (!active) return undefined;
    const uid = auth.currentUser?.uid;
    if (!uid) return undefined;
    let alive = true;
    (async () => {
      try {
        await flushPendingDriveWrites(uid);
        if (alive) setPendingDrives(await getPendingDriveCount(uid));
      } catch {}
    })();
    return () => {
      alive = false;
    };
  }, [active]);

  // ---- GPS staleness --------------------------------------------------------
  // `gpsStatus` used to latch on 'ok' at the first fix and never come back, so a lost signal
  // looked like a standing still at the last speed - and the monitoring speed gate (which is
  // fed only while the status is 'ok') would have kept a stale speed for the rest of the drive.
  // A 5 s check is enough for a 10 s staleness rule and, in the normal case, changes no state
  // and therefore renders nothing.
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => {
      const last = lastFixAtRef.current;
      if (last !== null && Date.now() - last > FIX_STALE_MS) setGpsStatus('searching');
    }, FIX_STALE_CHECK_MS);
    return () => clearInterval(id);
  }, [active]);

  // ---- points timer --------------------------------------------------------
  const stopPointEarning = useCallback(() => {
    if (pointTimer.current) {
      clearTimeout(pointTimer.current);
      pointTimer.current = null;
    }
  }, []);

  const scheduleNextPoint = useCallback(() => {
    const currentSpeed = speedRef.current;
    const eff = limitInUnit();
    let delay = currentSpeed <= eff ? DEFAULT_DELAY : DEFAULT_DELAY + Math.min((currentSpeed - eff) / eff, 2) * 2000;
    // Above 150 % of the limit at schedule time: skip this tick entirely (as before).
    if (currentSpeed > eff * 1.5) {
      pointTimer.current = setTimeout(scheduleNextPoint, delay);
      return;
    }
    pointTimer.current = setTimeout(() => {
      const v = speedRef.current;
      const e = limitInUnit();
      const thresholdMoving = unitRef.current === 'kph' ? 16.0934 : 10;
      const earning =
        appActiveRef.current &&
        !isDistractedRef.current &&
        !pausePointsRef.current &&
        v <= e * 1.25 &&
        v > thresholdMoving;
      if (earning) {
        pointsRef.current += 1;
        setPoints(pointsRef.current);
      }
      scheduleNextPoint();
    }, delay);
  }, []);

  const startPointEarning = useCallback(() => {
    if (!pointTimer.current) scheduleNextPoint();
  }, [scheduleNextPoint]);

  useEffect(() => {
    if (!active) return undefined;
    startPointEarning();
    return () => stopPointEarning();
  }, [active, startPointEarning, stopPointEarning]);

  // ---- location watch ------------------------------------------------------
  // The watch is started and stopped imperatively (rather than only by the effect) because it is
  // also torn down while the app is in the background: `handleLocation` already discarded those
  // fixes, but on Android the FusedLocationProvider request stayed registered at
  // PRIORITY_HIGH_ACCURACY / 1 s for up to the two-minute auto-end window, burning the GPS for
  // data nothing reads. Every start is stamped with a generation so a slow `watchPositionAsync`
  // cannot install a subscription that a newer stop already cancelled.
  const watchGenRef = useRef(0);

  const stopLocationWatch = useCallback(() => {
    watchGenRef.current += 1;
    locationSub.current?.remove?.();
    locationSub.current = null;
  }, []);

  const startLocationWatch = useCallback(async () => {
    if (locationSub.current) return;
    const gen = (watchGenRef.current += 1);
    await loadSpeedLimitCache();
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (gen !== watchGenRef.current) return;
    if (status !== 'granted') {
      setGpsStatus('denied');
      return;
    }
    try {
      const sub = await Location.watchPositionAsync(
        // `distanceInterval: 0`: the consumers are a 1 Hz speedometer, the 2.5 s points tick and
        // the acceleration estimate, which needs evenly spaced samples (a 10 m filter starved it
        // at crawling speed and silently zeroed every hard-brake reading). The speed-limit lookup
        // owns its own 15 s / 250 m throttle, so this costs no extra network.
        { accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 0 },
        (loc) => {
          if (gen !== watchGenRef.current) return;
          handleLocation(loc);
        }
      );
      if (gen !== watchGenRef.current) sub.remove();
      else locationSub.current = sub;
    } catch (e) {
      console.warn('watchPositionAsync failed:', e);
      setGpsStatus('error');
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    startLocationWatch();
    return () => stopLocationWatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const fillFinalSegmentIfAny = async () => {
    try {
      const seg = currentSeg.current;
      const prevKph = prevFetchedLimit.current;
      if (seg.length >= 2 && prevKph != null) {
        const a = seg[0];
        const b = seg[seg.length - 1];
        if (haversineM(a, b) >= MIN_SEG_TO_FILL_M) fillCachePolyline(seg, prevKph, prevFetchedStreet.current);
      }
      await flushSpeedLimitCache();
    } catch (e) {
      console.warn('Final segment fill failed:', e);
    }
  };

  const handleLocation = async (loc) => {
    if (!appActiveRef.current) return;
    const lat = loc.coords.latitude;
    const lon = loc.coords.longitude;
    const rawSpeed = Math.max(0, loc.coords.speed ?? 0);
    const fixAt = Date.now();
    lastFixAtRef.current = fixAt;
    setLastFixAt(fixAt);
    setGpsStatus('ok');

    // Segment tracking for the polyline back-fill.
    const currPt = { latitude: lat, longitude: lon };
    const seg = currentSeg.current;
    if (seg.length === 0) {
      seg.push(currPt);
      segHeading.current = null;
    } else {
      const lastPt = seg[seg.length - 1];
      const d = haversineM(lastPt, currPt);
      if (d >= 5) {
        const brg = bearingDeg(lastPt, currPt);
        if (segHeading.current == null) segHeading.current = brg;
        const diff = Math.abs(segHeading.current - brg);
        const headingDelta = Math.min(diff, 360 - diff);
        const segLen = haversineM(seg[0], currPt);
        if (headingDelta > HEADING_TOL_DEG || segLen > MAX_SEG_LEN_M) {
          currentSeg.current = [lastPt, currPt];
          segHeading.current = brg;
        } else {
          seg.push(currPt);
          segHeading.current = segHeading.current * 0.9 + brg * 0.1;
        }
      }
    }

    // Distance.
    if (lastLocation.current) {
      totalDistance.current += distanceMeters(lastLocation.current.latitude, lastLocation.current.longitude, lat, lon);
    }
    lastLocation.current = { latitude: lat, longitude: lon };

    // Speed limit: the cache first (street-aware — a grid cell can straddle two
    // roads), then utils/speedLimits decides whether HERE may be asked (it owns the
    // 15 s / 250 m throttle and the per-cell in-flight collapse).
    const expectedStreet = prevFetchedStreet.current ?? null;
    const cachedLimit = lookupCachedSpeedLimit(lat, lon, { expectedStreet });
    if (cachedLimit) {
      limitKphRef.current = cachedLimit.valueKph;
      setLimitKph(cachedLimit.valueKph);
      setLimitSource('cache');
      if (prevFetchedLimit.current == null) {
        prevFetchedLimit.current = cachedLimit.valueKph;
        prevFetchedStreet.current = cachedLimit.street ?? undefined;
      }
    } else if (showSpeedLimitRef.current) {
      const result = await getSpeedLimit(lat, lon, { expectedStreet });
      if (result && result.valueKph != null) {
        const { valueKph, street } = result;
        const prevKph = prevFetchedLimit.current;
        const prevStreet = prevFetchedStreet.current;
        const changedLimit = prevKph != null && Math.abs(prevKph - valueKph) >= 0.5;
        const changedStreet = prevStreet && street && prevStreet !== street;
        if ((changedLimit || changedStreet) && currentSeg.current.length >= 2) {
          const a = currentSeg.current[0];
          const b = currentSeg.current[currentSeg.current.length - 1];
          if (haversineM(a, b) >= MIN_SEG_TO_FILL_M) fillCachePolyline(currentSeg.current, prevKph, prevStreet);
          currentSeg.current = [{ latitude: lat, longitude: lon }];
          segHeading.current = null;
        }
        limitKphRef.current = valueKph;
        setLimitKph(valueKph);
        setLimitSource(result.cached ? 'cache' : 'fetched');
        prevFetchedLimit.current = valueKph;
        prevFetchedStreet.current = street;
      }
    }

    // Speed in display units.
    const speedU = speedFromMps(rawSpeed, unitRef.current);
    speedRef.current = speedU;
    rawSpeedRef.current = rawSpeed;
    setRawSpeedMps(rawSpeed);
    totalSpeedSum.current += speedU;
    speedSampleCount.current += 1;
    if (speedU > maxSpeedRef.current) maxSpeedRef.current = speedU;

    const limitU = limitInUnit();
    if (speedU > limitU) {
      speedingMarginSum.current += speedU - limitU;
      speedingSampleCount.current += 1;
    }
    const speedingNow = Math.round(speedU) > limitU * 1.25;
    setIsSpeeding(speedingNow);
    if (speedingNow && !wasSpeedingRef.current) {
      speedingEvents.current += 1;
      wasSpeedingRef.current = true;
    } else if (!speedingNow) {
      wasSpeedingRef.current = false;
    }

    // Drive "really started" once moving above the threshold.
    const thresholdMoving = unitRef.current === 'kph' ? 16.0934 : 10;
    if (!hasStartedRef.current && speedU >= thresholdMoving) {
      hasStartedRef.current = true;
      setHasStarted(true);
      const liveUid = auth.currentUser?.uid;
      if (liveUid) startDriving(liveUid);
    }

    // Hard brake / acceleration (m/s²).
    const nowAccel = Date.now();
    const dt = (nowAccel - lastAccelTime.current) / 1000;
    const prevMS = lastSpeedMS.current ?? rawSpeed;
    // Ignore implausible intervals (first sample, or a long gap while backgrounded).
    const accel = dt > 0.2 && dt < 10 ? (rawSpeed - prevMS) / dt : 0;
    if (accel > ACCEL_THRESHOLD) suddenAccels.current += 1;
    if (accel < BRAKE_THRESHOLD) suddenStops.current += 1;
    lastSpeedMS.current = rawSpeed;
    lastAccelTime.current = nowAccel;

    // Weather (≥ 5 min and ≥ 1 km since the last fetch).
    const elapsedW = (nowAccel - lastWeatherFetch.current) / 1000;
    const distW = lastWeatherCoords.current
      ? distanceMeters(lastWeatherCoords.current.latitude, lastWeatherCoords.current.longitude, lat, lon)
      : Infinity;
    if (elapsedW >= WEATHER_MIN_INTERVAL_S && distW >= WEATHER_MIN_DISTANCE_M) {
      lastWeatherFetch.current = nowAccel;
      lastWeatherCoords.current = { latitude: lat, longitude: lon };
      try {
        const data = await fetchWeather(lat, lon);
        if (data) setWeather(data);
      } catch (err) {
        console.error('Weather fetch error:', err);
      }
    }
  };

  // ---- road summary (GPT with a local fallback) ----------------------------
  useEffect(() => {
    if (!weather?.current) return;
    const currentMetrics = {
      visibility: weather.current.visibility,
      precipitation: weather.current.precipitation,
      precipitation_probability: weather.current.precipitation_probability,
      slippery: isRoadSlippery(weather),
    };
    if (!hasSignificantChange(lastWeatherMetrics.current, currentMetrics)) return;
    lastWeatherMetrics.current = currentMetrics;
    const fallback = localRoadSummary(weather);
    if (fallback && !roadSummaryRef.current) setRoadSummary({ ...fallback, source: 'local' });
    let cancelled = false;
    (async () => {
      try {
        const result = await getRoadConditionSummary(currentMetrics);
        if (!cancelled && result && result.summary) setRoadSummary({ ...result, source: 'ai' });
      } catch (err) {
        if (!cancelled && fallback) setRoadSummary({ ...fallback, source: 'local' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [weather]);

  // ---- spoken speed-limit changes -----------------------------------------
  useEffect(() => {
    if (!active || !audioSpeedUpdatesEnabled || limitKph == null || limitSource === 'default') return;
    const rounded = Math.round(toDisplayUnits(limitKph, unit));
    if (prevSpokenLimit.current === rounded) return;
    prevSpokenLimit.current = rounded;
    // INFO priority: this must never cut off a monitoring alert (utils/speech.js).
    speak(`Speed limit ${rounded}`, { priority: SPEECH_PRIORITY.INFO });
  }, [limitKph, limitSource, unit, audioSpeedUpdatesEnabled, active]);

  // ---- speeding alert (2.5 s sustained) -----------------------------------
  useEffect(() => {
    if (speedingWarningsEnabled && isSpeeding) {
      if (!speedingTimeout.current) {
        speedingTimeout.current = setTimeout(() => setSpeedingAlertOn(true), SPEEDING_GRACE_MS);
      }
    } else {
      if (speedingTimeout.current) {
        clearTimeout(speedingTimeout.current);
        speedingTimeout.current = null;
      }
      setSpeedingAlertOn(false);
    }
    return undefined;
  }, [isSpeeding, speedingWarningsEnabled]);
  useEffect(() => () => { if (speedingTimeout.current) clearTimeout(speedingTimeout.current); }, []);

  // ---- phone use (AppState) ------------------------------------------------
  useEffect(() => {
    if (!active) return undefined;
    const onChange = async (next) => {
      const wasActive = appActiveRef.current;
      const nowActive = next === 'active';
      appActiveRef.current = nowActive;

      if (wasActive && !nowActive) {
        // Nothing reads a background fix (see the guard at the top of handleLocation), so stop
        // paying for it. The drive itself keeps running: the auto-end timer below is independent.
        stopLocationWatch();
        unfocusedAt.current = Date.now();
        setPhone((p) => ({ ...p, awayNow: true }));
        if (hasStartedRef.current) {
          pickupsRef.current += 1;
          setPhone((p) => ({ ...p, pickups: pickupsRef.current }));
          if (settingsRef.current.distractedNotificationsEnabled) {
            firstNotificationId.current = await scheduleFirstDistractedNotification();
          }
        }
        backgroundTimeout.current = setTimeout(async () => {
          if (hasStartedRef.current) {
            isDistractedRef.current = true;
            phoneUsageSecRef.current += Math.round((Date.now() - (unfocusedAt.current ?? Date.now())) / 1000);
            unfocusedAt.current = null;
            setPhone((p) => ({ ...p, distracted: true }));
            if (settingsRef.current.notifyDriveComplete) {
              try {
                await Notifications.scheduleNotificationAsync({
                  content: { title: 'Drive ended', body: 'Your drive ended after 2 minutes away from RoadWise. Your streak was reset.' },
                  trigger: null,
                });
              } catch {}
            }
          }
          // Awaited: the screen's getFinalizeExtra flushes the monitoring engine's final state
          // before the record is built, so an auto-ended drive carries the same numbers a
          // hold-to-end one does.
          let extra = {};
          try { extra = (await getFinalizeExtraRef.current?.()) || {}; } catch { extra = {}; }
          const summary = await finalize({ ...extra, autoEnded: true });
          onAutoEndRef.current?.(summary);
        }, AUTO_END_MS);
      }

      if (nowActive) {
        if (!finalizedRef.current) startLocationWatch();
        // A fix cannot have arrived while the watch was down; do not let the staleness check
        // fire on the gap itself before the first new fix lands.
        lastFixAtRef.current = Date.now();
      }

      if (nowActive && unfocusedAt.current) {
        const away = Date.now() - unfocusedAt.current;
        if (backgroundTimeout.current) {
          clearTimeout(backgroundTimeout.current);
          backgroundTimeout.current = null;
        }
        if (hasStartedRef.current) {
          if (away > PHONE_GRACE_MS) {
            isDistractedRef.current = true;
            phoneUsageSecRef.current += Math.round(away / 1000);
            setPhone((p) => ({ ...p, distracted: true, awayNow: false }));
            if (firstNotificationId.current) {
              try { await Notifications.cancelScheduledNotificationAsync(firstNotificationId.current); } catch {}
              firstNotificationId.current = null;
            }
            if (settingsRef.current.distractedNotificationsEnabled) await scheduleDistractedNotification();
          } else {
            setPhone((p) => ({ ...p, awayNow: false }));
            if (firstNotificationId.current) {
              try { await Notifications.cancelScheduledNotificationAsync(firstNotificationId.current); } catch {}
              firstNotificationId.current = null;
            }
          }
        } else {
          setPhone((p) => ({ ...p, awayNow: false }));
        }
        unfocusedAt.current = null;
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => {
      sub.remove();
      if (backgroundTimeout.current) {
        clearTimeout(backgroundTimeout.current);
        backgroundTimeout.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ---- finalize ------------------------------------------------------------
  // extra: { monitoring: { enabled, metrics, calibrationState }, autoEnded }
  // Returns the summary object consumed by DriveSummaryScreen.
  const finalize = useCallback((extra = {}) => {
    // Concurrent callers (hold-to-end racing the auto-end) share one result.
    if (finalizedRef.current) return Promise.resolve(finalizedRef.current);
    const run = finalizeOnce(extra);
    finalizedRef.current = run;
    run.then((summary) => { finalizedRef.current = summary; });
    return run;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finalizeOnce = async (extra = {}) => {
    stopPointEarning();
    stopLocationWatch();
    stopSpeech();

    const user = auth.currentUser;
    // Independent of everything below. If the finalization batch fails, isDriving must
    // still be cleared or the user shows as driving to their group forever.
    if (user) stopDriving(user.uid);

    const durationSec = Math.round((Date.now() - startTime.current) / 1000);
    const pts = pointsRef.current;
    const u = unitRef.current;
    // [MP-4] The monitoring block is written only when the caller supplies one
    // (DriveScreen does so only when MONITORING_AVAILABLE is true).
    const monitoringRecord = extra.monitoring
      ? buildMonitoringRecord({
          enabled: !!extra.monitoring.enabled,
          metrics: extra.monitoring.metrics,
          calibrationState: extra.monitoring.calibrationState,
        })
      : null;
    const mv = monitoringRecord ? monitoringVerdict(monitoringRecord) : { distracted: false, reasons: [] };
    const phoneDistracted = isDistractedRef.current;
    const reasons = [];
    if (phoneDistracted) reasons.push(pickupsRef.current > 0 ? `${pickupsRef.current} phone pickup${pickupsRef.current === 1 ? '' : 's'}` : 'phone use');
    for (const r of mv.reasons) if (!reasons.includes(r)) reasons.push(r);
    const wasDistracted = phoneDistracted || mv.distracted;

    const w = weatherRef.current;
    const rs = roadSummaryRef.current;
    // The drive record. `timestamp` is set by finalizeDriveWrite (serverTimestamp,
    // required by the rules), so it is deliberately absent here.
    const base = {
      points: pts,
      duration: durationSec,
      distracted: pickupsRef.current,
      avgSpeed: speedSampleCount.current ? totalSpeedSum.current / speedSampleCount.current : 0,
      avgSpeedingMargin: speedingSampleCount.current ? speedingMarginSum.current / speedingSampleCount.current : 0,
      suddenStops: suddenStops.current,
      suddenAccelerations: suddenAccels.current,
      phoneUsageTime: phoneUsageSecRef.current,
      totalDistance: totalDistance.current ?? 0,
      speedingEvents: speedingEvents.current,
      // new optional fields
      maxSpeed: maxSpeedRef.current,
      unit: u,
      wasDistracted,
      distractionReasons: reasons,
      autoEnded: !!extra.autoEnded,
    };
    if (monitoringRecord) {
      base.monitoring = monitoringRecord;
      base.eyesOffRoadSeconds = monitoringRecord.enabled ? monitoringRecord.eyesOffRoadSeconds : 0;
    }
    if (w?.current) {
      base.weather = {
        code: w.current.weathercode ?? null,
        temperature: w.current.temperature_2m ?? null,
        summary: rs?.summary ?? getWeatherInfo(w.current.weathercode).label,
        roadScore: rs?.score ?? null,
      };
    }
    const { score, breakdown } = scoreDrive(base);
    const metrics = { ...base, score, scoreBreakdown: breakdown };

    // One atomic write for the drive record, the points, the streak and the drive
    // count (utils/firestore.js#finalizeDriveWrite); a failed commit is queued in
    // AsyncStorage and retried on the next launch and the next drive start.
    const previousStreak = Number(extra.previousStreak) || 0;
    let newStreak = null;
    let saved = false;
    let queued = false;
    let totalPoints = null;
    let driveId = null;
    if (user && pts > 0) {
      try {
        await fillFinalSegmentIfAny();
      } catch {}
      try {
        const result = await finalizeDriveWrite(user.uid, { metrics, pointsEarned: pts, wasDistracted });
        if (result) {
          driveId = result.driveId;
          queued = !!result.queued;
          totalPoints = result.totalPoints;
          saved = true; // committed, or held for retry
          newStreak = typeof result.streak === 'number' ? result.streak : wasDistracted ? 0 : previousStreak + 1;
          if (queued) {
            try {
              setPendingDrives(await getPendingDriveCount(user.uid));
            } catch {}
          } else {
            invalidateInsightsCache();
            invalidateDriveCounts();
            invalidateLeaderboard();
          }
        }
      } catch (e) {
        console.warn('Failed to save the completed drive:', e);
      }
    } else {
      try {
        await flushSpeedLimitCache();
      } catch {}
    }

    const summary = {
      ...metrics,
      timestamp: new Date().toISOString(), // display only; the record's timestamp is server time
      saved,
      queued,
      driveId,
      totalPoints,
      previousStreak,
      newStreak: newStreak ?? previousStreak,
      streakChanged: newStreak !== null,
    };
    return summary;
  };

  // ---- derived -------------------------------------------------------------
  const speed = speedFromMps(rawSpeedMps, unit);
  const limit = toDisplayUnits(limitKph ?? defaultLimitKph, unit);
  const limitIsDefault = limitKph == null;

  const speedingAlert = useMemo(
    () =>
      speedingAlertOn
        ? {
            id: 'speeding',
            severity: ALERT_SEVERITY.WARNING,
            audibleSeverity: ALERT_SEVERITY.CRITICAL,
            title: 'Slow down',
            message: `Over ${Math.round(limit)} ${unit === 'kph' ? 'km/h' : 'mph'} limit`,
            speech: null,
            icon: 'speedometer-outline',
            audio: { voice: false, tone: true, haptic: false }, // "tone and banner", as Driving settings say
          }
        : null,
    [speedingAlertOn, limit, unit]
  );

  const phoneAlert = useMemo(
    () =>
      phone.distracted
        ? {
            id: 'phone',
            severity: ALERT_SEVERITY.WARNING,
            audibleSeverity: ALERT_SEVERITY.WARNING,
            title: 'Phone use detected',
            message: 'Streak lost · points paused',
            speech: null,
            icon: 'phone-portrait-outline',
            audio: { voice: false, tone: false, haptic: false }, // banner + notification only (as before)
          }
        : null,
    [phone.distracted]
  );

  // Memoised: the screen passes `session.*` into children and builds callbacks from it, so a new
  // object on every render would defeat every React.memo below it and re-create `endDrive` on
  // each GPS fix.
  return useMemo(
    () => ({
      speed,
      limit,
      limitIsDefault,
      limitSource,
      isSpeeding,
      speedingAlert,
      phoneAlert,
      points,
      // The drive's start time, not a ticking second count: the clock is rendered by a leaf that
      // owns its own 1 Hz timer, so the rest of the screen no longer re-renders once a second.
      startedAt: startTime.current,
      // When the last usable fix arrived (ms epoch), so the monitoring speed gate can tell a
      // genuinely fresh speed from a repeat of the last one.
      lastFixAt,
      hasStarted,
      phone,
      weather,
      roadSummary,
      gpsStatus,
      pendingDrives,
      finalize,
    }),
    [speed, limit, limitIsDefault, limitSource, isSpeeding, speedingAlert, phoneAlert, points,
     lastFixAt, hasStarted, phone, weather, roadSummary, gpsStatus, pendingDrives, finalize]
  );
}

export default useDriveSession;

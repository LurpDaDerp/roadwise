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
// New: [MP-4] monitoring metrics stored in the record, [MP-5] `pausePoints`
// suspends the timer while a CRITICAL monitoring alert is active, top speed and
// real phone-usage seconds are recorded, a per-drive score is computed.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as Speech from 'expo-speech';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from '../utils/firebase';
import { saveDriveMetrics, startDriving, stopDriving, addUserPoints } from '../utils/firestore';
import { scheduleDistractedNotification, scheduleFirstDistractedNotification } from '../utils/notifications';
import { fetchWeather } from '../utils/weather';
import { getRoadConditionSummary } from '../utils/gptApi';
import {
  loadSpeedLimitCache,
  saveSpeedLimitCache,
  getCachedLimit,
  setCachedLimit,
  fillCachePolyline,
  fetchSpeedLimit,
  haversineM,
  bearingDeg,
  getDistanceMeters,
  kphToUnit,
  MIN_SEG_TO_FILL_M,
  HEADING_TOL_DEG,
  MAX_SEG_LEN_M,
  FETCH_MIN_INTERVAL_MS,
  FETCH_MIN_DISTANCE_M,
} from '../utils/speedLimit';
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

let lastSpeedLimitFetchTime = 0;
let lastSpeedLimitFetchCoords = null;

export function useDriveSession({
  active = true,
  unit = 'mph',
  showSpeedLimit = true,
  audioSpeedUpdatesEnabled = true,
  speedingWarningsEnabled = true,
  distractedNotificationsEnabled = true,
  notifyDriveComplete = true,
  pausePoints = false,
  voiceAlerts = true,
  onAutoEnd,
} = {}) {
  const uid = auth.currentUser?.uid || null;

  // ---- render state -------------------------------------------------------
  const [rawSpeedMps, setRawSpeedMps] = useState(0);
  const [limitKph, setLimitKph] = useState(null);
  const [limitSource, setLimitSource] = useState('default'); // 'default' | 'cache' | 'fetched'
  const [points, setPoints] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [phone, setPhone] = useState({ pickups: 0, distracted: false, awayNow: false });
  const [weather, setWeather] = useState(null);
  const [roadSummary, setRoadSummary] = useState(null);
  const [gpsStatus, setGpsStatus] = useState('searching'); // 'searching' | 'ok' | 'denied' | 'error'
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
  const settingsRef = useRef({ distractedNotificationsEnabled, notifyDriveComplete, speedingWarningsEnabled });

  useEffect(() => { unitRef.current = unit; }, [unit]);
  useEffect(() => { pausePointsRef.current = pausePoints; }, [pausePoints]);
  useEffect(() => { showSpeedLimitRef.current = showSpeedLimit; }, [showSpeedLimit]);
  useEffect(() => { onAutoEndRef.current = onAutoEnd; }, [onAutoEnd]);
  useEffect(() => {
    settingsRef.current = { distractedNotificationsEnabled, notifyDriveComplete, speedingWarningsEnabled };
  }, [distractedNotificationsEnabled, notifyDriveComplete, speedingWarningsEnabled]);
  useEffect(() => { weatherRef.current = weather; }, [weather]);
  useEffect(() => { roadSummaryRef.current = roadSummary; }, [roadSummary]);

  const defaultLimitKph = DEFAULT_SPEED_LIMIT_MPH * 1.60934;
  const effectiveLimitKph = () => limitKphRef.current ?? defaultLimitKph;
  const limitInUnit = () => kphToUnit(effectiveLimitKph(), unitRef.current);

  // ---- elapsed ticker ------------------------------------------------------
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startTime.current) / 1000)), 1000);
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
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    (async () => {
      await loadSpeedLimitCache();
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setGpsStatus('denied');
        return;
      }
      try {
        const sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 10 },
          (loc) => {
            if (cancelled) return;
            handleLocation(loc);
          }
        );
        if (cancelled) sub.remove();
        else locationSub.current = sub;
      } catch (e) {
        console.warn('watchPositionAsync failed:', e);
        setGpsStatus('error');
      }
    })();
    return () => {
      cancelled = true;
      locationSub.current?.remove?.();
      locationSub.current = null;
      fillFinalSegmentIfAny();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const fillFinalSegmentIfAny = async () => {
    try {
      const seg = currentSeg.current;
      const prevKph = prevFetchedLimit.current;
      if (seg.length >= 2 && prevKph != null) {
        const a = seg[0];
        const b = seg[seg.length - 1];
        if (haversineM(a, b) >= MIN_SEG_TO_FILL_M) await fillCachePolyline(seg, prevKph, prevFetchedStreet.current);
      }
    } catch (e) {
      console.warn('Final segment fill failed:', e);
    }
  };

  const handleLocation = async (loc) => {
    if (!appActiveRef.current) return;
    const lat = loc.coords.latitude;
    const lon = loc.coords.longitude;
    const rawSpeed = Math.max(0, loc.coords.speed ?? 0);
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
      totalDistance.current += getDistanceMeters(lastLocation.current.latitude, lastLocation.current.longitude, lat, lon);
    }
    lastLocation.current = { latitude: lat, longitude: lon };

    // Speed limit: cache first, then a throttled HERE lookup.
    const cached = getCachedLimit(lat, lon);
    if (cached) {
      limitKphRef.current = cached.valueKph;
      setLimitKph(cached.valueKph);
      setLimitSource('cache');
      if (prevFetchedLimit.current == null) {
        prevFetchedLimit.current = cached.valueKph;
        prevFetchedStreet.current = cached.street ?? undefined;
      }
    } else {
      const now = Date.now();
      const distSinceLastFetch = lastSpeedLimitFetchCoords
        ? getDistanceMeters(lastSpeedLimitFetchCoords.latitude, lastSpeedLimitFetchCoords.longitude, lat, lon)
        : Infinity;
      if (showSpeedLimitRef.current && now - lastSpeedLimitFetchTime > FETCH_MIN_INTERVAL_MS && distSinceLastFetch >= FETCH_MIN_DISTANCE_M) {
        lastSpeedLimitFetchTime = now;
        lastSpeedLimitFetchCoords = { latitude: lat, longitude: lon };
        const result = await fetchSpeedLimit(lat, lon);
        if (result && result.valueKph != null) {
          const { valueKph, street } = result;
          const prevKph = prevFetchedLimit.current;
          const prevStreet = prevFetchedStreet.current;
          const changedLimit = prevKph != null && Math.abs(prevKph - valueKph) >= 0.5;
          const changedStreet = prevStreet && street && prevStreet !== street;
          if ((changedLimit || changedStreet) && currentSeg.current.length >= 2) {
            const a = currentSeg.current[0];
            const b = currentSeg.current[currentSeg.current.length - 1];
            if (haversineM(a, b) >= MIN_SEG_TO_FILL_M) await fillCachePolyline(currentSeg.current, prevKph, prevStreet);
            currentSeg.current = [{ latitude: lat, longitude: lon }];
            segHeading.current = null;
          }
          setCachedLimit(lat, lon, valueKph, street);
          await saveSpeedLimitCache();
          limitKphRef.current = valueKph;
          setLimitKph(valueKph);
          setLimitSource('fetched');
          prevFetchedLimit.current = valueKph;
          prevFetchedStreet.current = street;
        }
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
      if (uid) startDriving(uid);
    }

    // Hard brake / acceleration (m/s²).
    const nowAccel = Date.now();
    const dt = (nowAccel - lastAccelTime.current) / 1000;
    const prevMS = lastSpeedMS.current ?? rawSpeed;
    const accel = dt > 0 ? (rawSpeed - prevMS) / dt : 0;
    if (accel > ACCEL_THRESHOLD) suddenAccels.current += 1;
    if (accel < BRAKE_THRESHOLD) suddenStops.current += 1;
    lastSpeedMS.current = rawSpeed;
    lastAccelTime.current = nowAccel;

    // Weather (≥ 10 s and ≥ 100 m since the last fetch).
    const elapsedW = (nowAccel - lastWeatherFetch.current) / 1000;
    const distW = lastWeatherCoords.current
      ? getDistanceMeters(lastWeatherCoords.current.latitude, lastWeatherCoords.current.longitude, lat, lon)
      : Infinity;
    if (elapsedW >= 10 && distW >= 100) {
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
    const rounded = Math.round(kphToUnit(limitKph, unit));
    if (prevSpokenLimit.current === rounded) return;
    prevSpokenLimit.current = rounded;
    if (!voiceAlerts) return;
    Speech.stop();
    Speech.speak(`Speed limit ${rounded}`, { language: 'en', pitch: 0.9, rate: 0.95 });
  }, [limitKph, limitSource, unit, audioSpeedUpdatesEnabled, active, voiceAlerts]);

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
          const summary = await finalize({ autoEnded: true });
          onAutoEndRef.current?.(summary);
        }, AUTO_END_MS);
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
  const finalize = useCallback(async (extra = {}) => {
    if (finalizedRef.current) return finalizedRef.current === true ? null : finalizedRef.current;
    finalizedRef.current = true;
    stopPointEarning();
    locationSub.current?.remove?.();
    locationSub.current = null;
    Speech.stop();

    const durationSec = Math.round((Date.now() - startTime.current) / 1000);
    const pts = pointsRef.current;
    const u = unitRef.current;
    const monitoringRecord = buildMonitoringRecord({
      enabled: !!extra.monitoring?.enabled,
      metrics: extra.monitoring?.metrics,
      calibrationState: extra.monitoring?.calibrationState,
    });
    const mv = monitoringVerdict(monitoringRecord);
    const phoneDistracted = isDistractedRef.current;
    const reasons = [];
    if (phoneDistracted) reasons.push(pickupsRef.current > 0 ? `${pickupsRef.current} phone pickup${pickupsRef.current === 1 ? '' : 's'}` : 'phone use');
    reasons.push(...mv.reasons);
    const wasDistracted = phoneDistracted || mv.distracted;

    const w = weatherRef.current;
    const rs = roadSummaryRef.current;
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
      monitoring: monitoringRecord,
      eyesOffRoadSeconds: monitoringRecord.enabled ? monitoringRecord.eyesOffRoadSeconds : 0,
      autoEnded: !!extra.autoEnded,
    };
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

    let previousStreak = 0;
    let newStreak = null;
    let saved = false;
    const user = auth.currentUser;
    if (user) {
      stopDriving(user.uid);
      if (pts > 0) {
        try {
          await fillFinalSegmentIfAny();
          await saveDriveMetrics(user.uid, { ...metrics, timestamp: new Date().toISOString() });
          saved = true;
        } catch (e) {
          console.warn('Failed to save drive history:', e);
        }
        try {
          const userRef = doc(db, 'users', user.uid);
          const snap = await getDoc(userRef);
          previousStreak = snap.exists() && snap.data().drivingStreak ? Number(snap.data().drivingStreak) : 0;
          newStreak = wasDistracted ? 0 : previousStreak + 1;
          await setDoc(userRef, { drivingStreak: newStreak }, { merge: true });
        } catch (e) {
          console.warn('Failed to update drive streak:', e);
        }
        await addUserPoints(user.uid, pts);
      }
    }

    const summary = {
      ...metrics,
      timestamp: new Date().toISOString(),
      saved,
      previousStreak,
      newStreak: newStreak ?? previousStreak,
      streakChanged: newStreak !== null,
    };
    finalizedRef.current = summary;
    return summary;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- derived -------------------------------------------------------------
  const speed = speedFromMps(rawSpeedMps, unit);
  const limit = kphToUnit(limitKph ?? defaultLimitKph, unit);
  const limitIsDefault = limitKph == null;
  const distanceMeters = totalDistance.current;

  const speedingAlert = useMemo(
    () =>
      speedingAlertOn
        ? {
            id: 'speeding',
            severity: ALERT_SEVERITY.WARNING,
            audibleSeverity: ALERT_SEVERITY.CRITICAL,
            title: 'Slow down',
            message: `Over ${Math.round(limit)} ${unit === 'kph' ? 'km/h' : 'mph'} limit`,
            speech: 'Slow down',
            icon: 'speedometer-outline',
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
            speech: 'Phone down. Eyes on the road.',
            icon: 'phone-portrait-outline',
          }
        : null,
    [phone.distracted]
  );

  return {
    speed,
    limit,
    limitIsDefault,
    limitSource,
    isSpeeding,
    speedingAlert,
    phoneAlert,
    points,
    elapsed,
    distanceMeters,
    hasStarted,
    phone,
    weather,
    roadSummary,
    gpsStatus,
    finalize,
  };
}

export default useDriveSession;

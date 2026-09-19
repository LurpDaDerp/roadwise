// DriveScreen — the live drive, designed for glanceability:
//   top     elapsed time · monitoring status · SOS
//   middle  the speed, huge and centred, with the limit sign beside it
//   bottom  one stats strip (points + road) and hold-to-end
// Alerts float over the top of the speed area, so nothing jumps when one appears.
// Audio-first alerts, no modals, keep-awake. The engine lives in hooks/useDriveSession.
//
// ============================================================================
// MONITORING MOUNT POINTS (docs/UX_REWORK.md §5.3)
//   [MP-1] status pill        → DriveTopBar (components/drive/DriveTopBar.js)
//   [MP-2] alert slot         → the floating alert area below the top bar
//   [MP-3] critical overlay   → <CriticalOverlay/> last child of the root view
//   [MP-4] metrics in record  → getFinalizeExtra() → useDriveSession.finalize()
//   [MP-5] points pause       → useDriveSession({ pausePoints })
// The real camera + gaze + rule-engine hook is live (monitoring/useDriverMonitoring.js);
// MONITORING_AVAILABLE in monitoring/settings.js remains the kill switch, and
// `demoMonitoring` runs the scripted mock whose numbers never reach a record.
//
// RENDER BUDGET: this screen is mounted for the whole drive with the screen forced
// awake, so nothing here may re-render the tree on a timer. The elapsed clock ticks
// inside DriveTopBar, the monitoring hook publishes at most 4 Hz and only on change,
// every child in components/drive is memoised, and every prop handed to one is stable.
// ============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, BackHandler, Platform, StyleSheet, ToastAndroid } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme, Banner, Button } from '../theme';
import { useSettings } from '../context/SettingsContext';
import { useAuthContext } from '../context/AuthContext';
import { useDriveSession } from '../hooks/useDriveSession';
import { useEmergency, callNumber } from '../hooks/useEmergency';
import { useDriverMonitoring } from '../monitoring/useDriverMonitoring';
import { useAlertAudio, useAlertSounds } from '../monitoring/alertAudio';
import { speak } from '../utils/speech';
import { ALERT_SEVERITY, alertCopy } from '../monitoring/types';
import { isAcknowledgeable } from '../monitoring/engineBridge';
import { monitoringSettingsFrom, MONITORING_AVAILABLE } from '../monitoring/settings';
import { AlertBanner } from '../components/monitoring/AlertBanner';
import { CriticalOverlay } from '../components/monitoring/CriticalOverlay';
import { SpeedHero, DriveStats, HoldToEndButton, EmergencySheet, DriveTopBar } from '../components/drive';

const alertTone = require('../assets/sounds/alert.mp3');
const SOS_CLEAR_TIMEOUT_MS = 5000;
// How long the "Got it" offer stays up after a CRITICAL alert clears. The overlay itself has no
// controls by design (the driver must not reach for the phone while it is showing), so this is
// the one safe moment to acknowledge one: it is over, and the driver is looking at the road again.
const CRITICAL_ACK_WINDOW_MS = 8000;
const KEEP_AWAKE_TAG = 'roadcash-drive';

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))]);
}

export default function DriveScreen({ navigation, route }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { settings } = useSettings();
  const { uid, points: lifetimePoints, streak: currentStreak, groupId } = useAuthContext();
  const player = useAudioPlayer(alertTone);
  // The four per-type monitoring tones (WARNINGS_DESIGN §3): closed-eye and drowsiness alerts
  // have to be acoustically distinct from attention alerts.
  const alertSounds = useAlertSounds();

  // Monitoring runs only when MONITORING_AVAILABLE; the `demoMonitoring`
  // route param still exercises the mock UI (never written to the record).
  const demo = !!route.params?.demoMonitoring;
  const monitoringEnabled = (MONITORING_AVAILABLE && (route.params?.monitoringEnabled ?? settings.monitoringEnabled)) || demo;
  const [ended, setEnded] = useState(false);
  const [sosOpen, setSosOpen] = useState(false);
  const [endState, setEndState] = useState('idle'); // 'idle' | 'saving' | 'sosFailed'
  const [frozenTotal, setFrozenTotal] = useState(null);
  const [topBarHeight, setTopBarHeight] = useState(60);
  const [endButtonHeight, setEndButtonHeight] = useState(64);
  const endingRef = useRef(false);
  const summaryRef = useRef(null);

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  }, []);

  // An automatic start happens while the car is already moving: confirm it by voice so the
  // driver never has to look at the phone to know the drive is being recorded.
  const autoStarted = !!route.params?.autoStarted;
  useEffect(() => {
    if (autoStarted) speak('Drive started');
  }, [autoStarted]);

  // Keep the screen awake only while the drive is RUNNING. `useKeepAwake()` holds it for as long
  // as the component is mounted, and this screen stays mounted after the drive has ended when
  // clearing the SOS alert fails - so the phone burned its screen until the driver noticed.
  useEffect(() => {
    if (ended) return undefined;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      try {
        const result = deactivateKeepAwake(KEEP_AWAKE_TAG);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (err) {
        // nothing to release
      }
    };
  }, [ended]);

  // ---- monitoring ----------------------------------------------------------
  const monitoringSettings = useMemo(() => monitoringSettingsFrom(settings), [settings]);
  // The rule engine's speed gate (docs/dms/DETECTION_DESIGN.md §8): km/h and the moment it was
  // measured, or null when the GPS speed is unknown. Set from an effect below because `session`
  // is defined after this call (it depends on `criticalActive`).
  const [monitorSpeed, setMonitorSpeed] = useState({ kmh: null, at: null });
  const monitoring = useDriverMonitoring({
    enabled: monitoringEnabled,
    driveActive: !ended,
    settings: monitoringSettings,
    demo,
    speedKmh: monitorSpeed.kmh,
    speedAt: monitorSpeed.at,
  });
  const criticalActive = monitoring.activeAlert?.severity === ALERT_SEVERITY.CRITICAL;
  const emergency = useEmergency(uid);

  // [MP-4] the monitoring payload stored in the drive record. `finalMetrics()` stops the camera
  // and publishes the engine's last state, so the record carries the whole drive rather than the
  // snapshot that happened to be rendered up to a second before the driver let go of the button.
  const monitoringRef = useRef(null);
  useEffect(() => {
    monitoringRef.current = MONITORING_AVAILABLE && !demo
      ? { enabled: monitoringEnabled, metrics: monitoring.metrics, calibrationState: monitoring.calibration?.state }
      : null;
  }, [monitoringEnabled, demo, monitoring.metrics, monitoring.calibration?.state]);
  const streakRef = useRef(currentStreak);
  useEffect(() => {
    streakRef.current = currentStreak;
  }, [currentStreak]);
  const finalMetricsRef = useRef(monitoring.finalMetrics);
  finalMetricsRef.current = monitoring.finalMetrics;
  const getFinalizeExtra = useCallback(async () => {
    const base = { previousStreak: streakRef.current };
    if (!monitoringRef.current) return base;
    let payload = monitoringRef.current;
    try {
      const flushed = await finalMetricsRef.current?.();
      if (flushed) payload = { ...payload, ...flushed };
    } catch (err) {
      // keep the last published metrics
    }
    return { ...base, monitoring: payload };
  }, []);

  // ---- drive engine --------------------------------------------------------
  const navigatedRef = useRef(false);
  const goToSummary = useCallback(
    (summary) => {
      if (!summary || navigatedRef.current) return;
      navigatedRef.current = true;
      navigation.replace('DriveSummary', { summary });
    },
    [navigation]
  );

  // Clear an active SOS with a bounded wait; returns true when cleared.
  const cancelGroupEmergency = emergency.cancelGroupEmergency;
  const isEmergencyActive = emergency.isEmergencyActive;
  const clearSosBounded = useCallback(async () => {
    if (!isEmergencyActive) return true;
    try {
      const r = await withTimeout(cancelGroupEmergency(), SOS_CLEAR_TIMEOUT_MS);
      return r === true;
    } catch {
      return false;
    }
  }, [isEmergencyActive, cancelGroupEmergency]);

  const session = useDriveSession({
    active: !ended,
    unit: settings.speedUnit,
    showSpeedLimit: settings.showSpeedLimit,
    audioSpeedUpdatesEnabled: settings.audioSpeedUpdatesEnabled,
    speedingWarningsEnabled: settings.speedingWarningsEnabled,
    distractedNotificationsEnabled: settings.distractedNotificationsEnabled,
    notifyDriveComplete: settings.notifyDriveComplete,
    // [MP-5] a demo alert must never pause the points of a real drive.
    pausePoints: criticalActive && !demo,
    getFinalizeExtra,
    onAutoEnd: async (summary) => {
      setEnded(true);
      setFrozenTotal((v) => (v == null ? lifetimePoints + (summary?.points ?? 0) : v));
      summaryRef.current = summary;
      // Best effort: the app is in the background; the SOS can still be cleared from Family.
      await clearSosBounded();
      goToSummary(summary);
    },
  });

  // Feed the monitoring speed gate (docs/dms/DETECTION_DESIGN.md §8): km/h while the GPS
  // reports a fresh fix, null (= unknown, rules fully active) otherwise. `lastFixAt` is what
  // lets the gate's own 10 s staleness rule work: without it, re-feeding the same value four
  // times a second would keep it looking fresh for ever.
  useEffect(() => {
    const ok = session.gpsStatus === 'ok' && session.lastFixAt != null;
    const kmh = ok ? Number(session.speed) * (settings.speedUnit === 'kph' ? 1 : 1.60934) : null;
    const at = ok ? session.lastFixAt : null;
    setMonitorSpeed((prev) => (prev.kmh === kmh && prev.at === at ? prev : { kmh, at }));
  }, [session.speed, session.gpsStatus, session.lastFixAt, settings.speedUnit]);

  // ---- acknowledgement -----------------------------------------------------
  // The CRITICAL overlay has no controls (pointerEvents none, by design). The moment it clears
  // is the safe one to offer an acknowledgement: `acknowledgeAlert` suppresses that alert type
  // for 30 s in the engine's own arbiter (Euro NCAP suppression-after-acknowledgement).
  const [clearedCritical, setClearedCritical] = useState(null);
  const previousAlertRef = useRef(null);
  useEffect(() => {
    const current = monitoring.activeAlert;
    const previous = previousAlertRef.current;
    previousAlertRef.current = current;
    if (!previous || previous.severity !== ALERT_SEVERITY.CRITICAL) return;
    if (current && current.id === previous.id) return;
    if (!isAcknowledgeable(previous.type)) return;   // closed eyes / driver absent: never
    setClearedCritical({ id: previous.id, title: previous.title });
  }, [monitoring.activeAlert]);

  useEffect(() => {
    if (!clearedCritical) return undefined;
    const id = setTimeout(() => setClearedCritical(null), CRITICAL_ACK_WINDOW_MS);
    return () => clearTimeout(id);
  }, [clearedCritical]);

  const acknowledgeAlert = monitoring.acknowledgeAlert;
  const dismissBannerAlert = useCallback(
    (id) => {
      acknowledgeAlert?.(id);
      setClearedCritical((c) => (c && c.id === id ? null : c));
    },
    [acknowledgeAlert]
  );

  // ---- alert precedence ----------------------------------------------------
  // Display: monitoring INFO/WARNING > the post-CRITICAL acknowledgement > SOS sent > speeding >
  // phone use. CRITICAL goes to the overlay.
  const monitoringBanner = useMemo(() => {
    const a = monitoring.activeAlert;
    if (!a || a.severity === ALERT_SEVERITY.CRITICAL) return null;
    const copy = alertCopy(a.type);
    return {
      id: a.id,
      type: a.type,
      severity: a.severity,
      title: a.title || copy.title,
      message: a.message || copy.message,
      icon: copy.icon,
      dismissible: isAcknowledgeable(a.type),
    };
  }, [monitoring.activeAlert]);

  const ackBanner = useMemo(
    () =>
      clearedCritical
        ? {
            id: clearedCritical.id,
            severity: ALERT_SEVERITY.INFO,
            title: 'Alert cleared',
            message: `${clearedCritical.title} — tap to mute repeats for 30 s`,
            icon: 'checkmark-circle-outline',
            dismissible: true,
          }
        : null,
    [clearedCritical]
  );

  const sosBanner = useMemo(
    () =>
      isEmergencyActive
        ? { id: 'sos', severity: ALERT_SEVERITY.WARNING, title: 'Emergency alert sent', message: 'Your group can see your location', icon: 'alert-circle' }
        : null,
    [isEmergencyActive]
  );
  const bannerAlert = monitoringBanner || ackBanner || sosBanner || session.speedingAlert || session.phoneAlert;
  const bannerOnDismiss = bannerAlert && bannerAlert.dismissible ? dismissBannerAlert : undefined;

  // Audio: the highest-priority audible alert. Monitoring alerts use the
  // monitoring voice / tone / haptic settings and the tone of their own type;
  // speeding and phone use carry their own modality (see useDriveSession).
  const audibleAlert = useMemo(() => {
    const a = monitoring.activeAlert;
    if (a) {
      const copy = alertCopy(a.type);
      return { id: a.id, severity: a.severity, speech: copy.speech, sound: copy.sound, title: a.title };
    }
    if (session.speedingAlert) return { ...session.speedingAlert, severity: session.speedingAlert.audibleSeverity };
    if (session.phoneAlert) return { ...session.phoneAlert, severity: session.phoneAlert.audibleSeverity };
    return null;
  }, [monitoring.activeAlert, session.speedingAlert, session.phoneAlert]);
  const audioConfig = useMemo(
    () => ({
      voice: settings.monitoringVoiceAlerts,
      tone: settings.monitoringToneAlerts,
      haptic: settings.monitoringHapticAlerts,
      player,
      players: alertSounds,
    }),
    [settings.monitoringVoiceAlerts, settings.monitoringToneAlerts, settings.monitoringHapticAlerts, player, alertSounds]
  );
  useAlertAudio(audibleAlert, audioConfig);

  // ---- ending --------------------------------------------------------------
  // Finalize FIRST (the record, streak and points are what matter), then clear
  // an active SOS with a 5 s bound; a failure keeps the user here with a retry.
  const endDrive = useCallback(async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    setEnded(true);
    setEndState('saving');
    setFrozenTotal(lifetimePoints + session.points);
    const summary = await session.finalize(await getFinalizeExtra());
    summaryRef.current = summary;
    const cleared = await clearSosBounded();
    if (!cleared) {
      setEndState('sosFailed');
      return;
    }
    goToSummary(summary);
  }, [session, getFinalizeExtra, goToSummary, clearSosBounded, lifetimePoints]);

  const retryClearSos = useCallback(async () => {
    setEndState('saving');
    const cleared = await clearSosBounded();
    if (!cleared) {
      setEndState('sosFailed');
      return;
    }
    goToSummary(summaryRef.current);
  }, [clearSosBounded, goToSummary]);

  const continueWithoutClearing = useCallback(() => goToSummary(summaryRef.current), [goToSummary]);

  // Android back: never ends a drive by accident.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (Platform.OS === 'android') ToastAndroid.show('Hold "End drive" to finish', ToastAndroid.SHORT);
      return true;
    });
    return () => sub.remove();
  }, []);

  // ---- stable handlers for the memoised children ---------------------------
  const openSos = useCallback(() => setSosOpen(true), []);
  const closeSos = useCallback(() => setSosOpen(false), []);
  const onTopBarLayout = useCallback((e) => setTopBarHeight(e.nativeEvent.layout.height), []);
  const onEndButtonLayout = useCallback((e) => setEndButtonHeight(e.nativeEvent.layout.height), []);
  const call911 = useCallback(() => {
    setSosOpen(false);
    callNumber('911');
  }, []);
  const notifyGroup = emergency.notifyGroup;
  const onNotifyGroup = useCallback(async () => {
    // The sheet stays open (busy) until the alert is confirmed sent.
    const ok = await notifyGroup();
    if (ok) setSosOpen(false);
  }, [notifyGroup]);
  const onCancelEmergency = useCallback(async () => {
    const ok = await cancelGroupEmergency();
    if (ok) setSosOpen(false);
  }, [cancelGroupEmergency]);
  const onCallContact = useCallback((phone) => {
    setSosOpen(false);
    callNumber(phone);
  }, []);

  // ---- points display ------------------------------------------------------
  const pointsState = session.phone.distracted
    ? 'distracted'
    : criticalActive
    ? 'paused'
    : !session.hasStarted
    ? 'idle'
    : 'focused';
  const shownPoints = settings.displayTotalPoints ? frozenTotal ?? lifetimePoints + session.points : session.points;
  const overlayAlert = useMemo(
    () => (!sosOpen && monitoring.activeAlert
      ? { ...monitoring.activeAlert, icon: alertCopy(monitoring.activeAlert.type).icon }
      : null),
    [sosOpen, monitoring.activeAlert]
  );
  const alertContent = bannerAlert ? (
    <AlertBanner alert={bannerAlert} onDismiss={bannerOnDismiss} />
  ) : session.gpsStatus === 'denied' ? (
    <Banner tone="danger" icon="navigate" title="Location is off" body="Enable location to track this drive" />
  ) : session.pendingDrives > 0 ? (
    <Banner
      tone="info"
      icon="cloud-upload-outline"
      title={session.pendingDrives === 1 ? 'A finished drive is waiting to upload' : `${session.pendingDrives} finished drives are waiting to upload`}
      body="They will be saved when you are back online"
    />
  ) : null;

  const rootStyle = useMemo(
    () => ({
      flex: 1,
      backgroundColor: t.colors.bg,
      paddingTop: insets.top + 8,
      paddingHorizontal: 18,
      paddingBottom: Math.max(insets.bottom, 16),
    }),
    [t.colors.bg, insets.top, insets.bottom]
  );

  return (
    <View style={rootStyle}>
      <View onLayout={onTopBarLayout}>
        <DriveTopBar
          onSos={openSos}
          status={monitoring.status}
          calibration={monitoring.calibration}
          monitoringEnabled={monitoringEnabled}
          showMonitoring={MONITORING_AVAILABLE || demo}
          startedAt={session.startedAt}
          running={!ended}
        />
      </View>

      <View style={styles.middle}>
        <SpeedHero
          speed={session.speed}
          limit={session.limit}
          unit={settings.speedUnit}
          isSpeeding={session.isSpeeding}
          limitIsDefault={session.limitIsDefault}
          showLimit={settings.showSpeedLimit}
          gpsStatus={session.gpsStatus}
        />
      </View>

      <DriveStats
        points={shownPoints}
        pointsLabel={settings.displayTotalPoints ? 'Lifetime points' : 'Points'}
        pointsState={pointsState}
        pausedReason="Paused · alert"
        weather={session.weather}
        roadSummary={session.roadSummary}
        unit={settings.speedUnit}
      />

      <View onLayout={onEndButtonLayout} style={styles.endArea}>
        {endState === 'sosFailed' ? (
          <View style={styles.sosFailed}>
            <Banner
              tone="danger"
              icon="cloud-offline-outline"
              title="Couldn't clear your SOS alert"
              body="Your drive is saved. Retry now, or continue and clear it later from Family."
            />
            <View style={styles.row}>
              <View style={styles.flex1}>
                <Button title="Retry" onPress={retryClearSos} />
              </View>
              <View style={styles.flex1}>
                <Button title="Continue" variant="ghost" onPress={continueWithoutClearing} />
              </View>
            </View>
          </View>
        ) : (
          <>
            <HoldToEndButton onComplete={endDrive} disabled={ended} />
            {ended && (
              <View style={styles.saving}>
                <Ionicons name="hourglass-outline" size={14} color={t.colors.textMuted} />
                <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>Saving your drive…</Text>
              </View>
            )}
          </>
        )}
      </View>

      {/* MONITORING MOUNT POINT [MP-2]: the alert area floats just below the top bar, over the
          top of the speed area, so the layout never jumps when an alert comes or goes. The forward
          reference is learned silently while driving (no calibration step, no banner). */}
      {alertContent && (
        <View pointerEvents="box-none" style={[styles.alertArea, { top: insets.top + 8 + topBarHeight + 10 }]}>
          {alertContent}
        </View>
      )}

      {/* Mounted only while it is open: a Modal with visible={false} still re-rendered its whole
          subtree on every drive tick. */}
      {sosOpen && (
        <EmergencySheet
          visible
          onClose={closeSos}
          contacts={emergency.trustedContacts}
          hasGroup={!!groupId}
          busy={emergency.busy}
          isEmergencyActive={isEmergencyActive}
          onCall911={call911}
          onNotifyGroup={onNotifyGroup}
          onCancelEmergency={onCancelEmergency}
          onCallContact={onCallContact}
        />
      )}

      {/* MONITORING MOUNT POINT [MP-3]: CRITICAL overlay, cut out around the SOS bar and the end control;
          suppressed while the SOS sheet is open so it never hides the sheet. */}
      <CriticalOverlay
        alert={overlayAlert}
        top={insets.top + 8 + topBarHeight + 4}
        bottom={Math.max(insets.bottom, 16) + endButtonHeight + 4}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  alertArea: { position: 'absolute', left: 18, right: 18, zIndex: 10 },
  middle: { flex: 1, justifyContent: 'center' },
  endArea: { marginTop: 14 },
  sosFailed: { gap: 10 },
  row: { flexDirection: 'row', gap: 10 },
  flex1: { flex: 1 },
  saving: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 10 },
});

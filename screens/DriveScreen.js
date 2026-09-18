// DriveScreen — the live drive, designed for glanceability: one huge speed,
// the limit sign, points and a one-line road summary. Audio-first alerts, no
// modals, keep-awake, hold-to-end. The engine lives in hooks/useDriveSession.
//
// ============================================================================
// MONITORING MOUNT POINTS (docs/UX_REWORK.md §5.3)
//   [MP-1] status pill        → DriveTopBar (components/drive/DriveTopBar.js)
//   [MP-2] alert slot         → <AlertSlot/> below the top bar
//   [MP-3] critical overlay   → <CriticalOverlay/> last child of the root view
//   [MP-4] metrics in record  → getFinalizeExtra() → useDriveSession.finalize()
//   [MP-5] points pause       → useDriveSession({ pausePoints })
// The real hook replaces monitoring/useDriverMonitoring.js and flips
// MONITORING_AVAILABLE in monitoring/settings.js; nothing here changes.
// ============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, BackHandler, Platform, ToastAndroid } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { Ionicons } from '@expo/vector-icons';

import { useTheme, Banner, Button } from '../theme';
import { useSettings } from '../context/SettingsContext';
import { useAuthContext } from '../context/AuthContext';
import { useDriveSession } from '../hooks/useDriveSession';
import { useEmergency, callNumber } from '../hooks/useEmergency';
import { useDriverMonitoring } from '../monitoring/useDriverMonitoring';
import { useAlertAudio } from '../monitoring/alertAudio';
import { ALERT_SEVERITY, alertCopy } from '../monitoring/types';
import { monitoringSettingsFrom, MONITORING_AVAILABLE } from '../monitoring/settings';
import { CalibrationGate, shouldShowCalibrationGate } from '../components/monitoring/CalibrationGate';
import { AlertBanner } from '../components/monitoring/AlertBanner';
import { CriticalOverlay } from '../components/monitoring/CriticalOverlay';
import { SpeedHero, PointsCard, ConditionsStrip, HoldToEndButton, EmergencySheet, DriveTopBar } from '../components/drive';

const alertTone = require('../assets/sounds/alert.mp3');
const SOS_CLEAR_TIMEOUT_MS = 5000;

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))]);
}

export default function DriveScreen({ navigation, route }) {
  useKeepAwake();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { settings } = useSettings();
  const { uid, points: lifetimePoints, streak: currentStreak, groupId } = useAuthContext();
  const player = useAudioPlayer(alertTone);

  // Monitoring runs only when the real hook is present; the `demoMonitoring`
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

  // ---- monitoring (mock until the monitoring branch lands) ----------------
  const monitoringSettings = useMemo(() => monitoringSettingsFrom(settings), [settings]);
  const monitoring = useDriverMonitoring({
    enabled: monitoringEnabled,
    driveActive: !ended,
    settings: monitoringSettings,
    demo,
  });
  const criticalActive = monitoring.activeAlert?.severity === ALERT_SEVERITY.CRITICAL;
  const emergency = useEmergency(uid);

  // [MP-4] the monitoring payload stored in the drive record — read at the
  // moment the drive ends, whether by hold-to-end or by the 2-minute auto-end.
  // Only supplied when the real hook is present, so the mock can never feed
  // fabricated data into history, achievements or insights.
  const monitoringRef = useRef(null);
  useEffect(() => {
    monitoringRef.current = MONITORING_AVAILABLE
      ? { enabled: monitoringEnabled, metrics: monitoring.metrics, calibrationState: monitoring.calibration?.state }
      : null;
  }, [monitoringEnabled, monitoring.metrics, monitoring.calibration?.state]);
  const streakRef = useRef(currentStreak);
  useEffect(() => {
    streakRef.current = currentStreak;
  }, [currentStreak]);
  const getFinalizeExtra = useCallback(
    () => ({ previousStreak: streakRef.current, ...(monitoringRef.current ? { monitoring: monitoringRef.current } : {}) }),
    []
  );

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
  const clearSosBounded = useCallback(async () => {
    if (!emergency.isEmergencyActive) return true;
    try {
      const r = await withTimeout(emergency.cancelGroupEmergency(), SOS_CLEAR_TIMEOUT_MS);
      return r === true;
    } catch {
      return false;
    }
  }, [emergency]);

  const session = useDriveSession({
    active: !ended,
    unit: settings.speedUnit,
    showSpeedLimit: settings.showSpeedLimit,
    audioSpeedUpdatesEnabled: settings.audioSpeedUpdatesEnabled,
    speedingWarningsEnabled: settings.speedingWarningsEnabled,
    distractedNotificationsEnabled: settings.distractedNotificationsEnabled,
    notifyDriveComplete: settings.notifyDriveComplete,
    pausePoints: criticalActive, // [MP-5]
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

  // ---- alert precedence ----------------------------------------------------
  // Display: monitoring INFO/WARNING > SOS sent > speeding > phone use. CRITICAL goes to the overlay.
  const monitoringBanner = useMemo(() => {
    const a = monitoring.activeAlert;
    if (!a || a.severity === ALERT_SEVERITY.CRITICAL) return null;
    const copy = alertCopy(a.type);
    return { id: a.id, severity: a.severity, title: a.title || copy.title, message: a.message || copy.message, icon: copy.icon };
  }, [monitoring.activeAlert]);
  const sosBanner = emergency.isEmergencyActive
    ? { id: 'sos', severity: ALERT_SEVERITY.WARNING, title: 'Emergency alert sent', message: 'Your group can see your location', icon: 'alert-circle' }
    : null;
  const bannerAlert = monitoringBanner || sosBanner || session.speedingAlert || session.phoneAlert;

  // Audio: the highest-priority audible alert. Monitoring alerts use the
  // monitoring voice / tone / haptic settings; speeding and phone use carry
  // their own modality (see useDriveSession).
  const audibleAlert = useMemo(() => {
    const a = monitoring.activeAlert;
    if (a) {
      const copy = alertCopy(a.type);
      return { id: a.id, severity: a.severity, speech: copy.speech, title: a.title };
    }
    if (session.speedingAlert) return { ...session.speedingAlert, severity: session.speedingAlert.audibleSeverity };
    if (session.phoneAlert) return { ...session.phoneAlert, severity: session.phoneAlert.audibleSeverity };
    return null;
  }, [monitoring.activeAlert, session.speedingAlert, session.phoneAlert]);
  useAlertAudio(audibleAlert, {
    voice: settings.monitoringVoiceAlerts,
    tone: settings.monitoringToneAlerts,
    haptic: settings.monitoringHapticAlerts,
    player,
  });

  // ---- ending --------------------------------------------------------------
  // Finalize FIRST (the record, streak and points are what matter), then clear
  // an active SOS with a 5 s bound; a failure keeps the user here with a retry.
  const endDrive = useCallback(async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    setEnded(true);
    setEndState('saving');
    setFrozenTotal(lifetimePoints + session.points);
    const summary = await session.finalize(getFinalizeExtra());
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

  // Android back: never ends a drive by accident.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (Platform.OS === 'android') ToastAndroid.show('Hold "End drive" to finish', ToastAndroid.SHORT);
      return true;
    });
    return () => sub.remove();
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
  const showCalibration = monitoringEnabled && shouldShowCalibrationGate(monitoring.calibration) && !bannerAlert;
  const overlayAlert = !sosOpen && monitoring.activeAlert ? { ...monitoring.activeAlert, icon: alertCopy(monitoring.activeAlert.type).icon } : null;

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg, paddingTop: insets.top + 8, paddingHorizontal: 18, paddingBottom: Math.max(insets.bottom, 16) }}>
      <View onLayout={(e) => setTopBarHeight(e.nativeEvent.layout.height)}>
        <DriveTopBar
          onSos={() => setSosOpen(true)}
          monitoring={monitoring}
          monitoringEnabled={monitoringEnabled}
          showMonitoring={MONITORING_AVAILABLE || demo}
          elapsed={session.elapsed}
          onPillPress={monitoringEnabled ? monitoring.recalibrate : undefined}
        />
      </View>

      {/* MONITORING MOUNT POINT [MP-2]: alert slot (calibration gate or INFO/WARNING banner) */}
      <View style={{ minHeight: 64, justifyContent: 'center', marginTop: 12 }}>
        {showCalibration ? (
          <CalibrationGate calibration={monitoring.calibration} onRecalibrate={monitoring.recalibrate} compact />
        ) : bannerAlert ? (
          <AlertBanner alert={bannerAlert} />
        ) : session.gpsStatus === 'denied' ? (
          <Banner tone="danger" icon="navigate" title="Location is off" body="Enable location to track this drive" />
        ) : session.pendingDrives > 0 ? (
          <Banner
            tone="info"
            icon="cloud-upload-outline"
            title={session.pendingDrives === 1 ? 'A finished drive is waiting to upload' : `${session.pendingDrives} finished drives are waiting to upload`}
            body="They will be saved when you are back online"
          />
        ) : null}
      </View>

      <View style={{ flex: 1, justifyContent: 'center', gap: 14 }}>
        <SpeedHero
          speed={session.speed}
          limit={session.limit}
          unit={settings.speedUnit}
          isSpeeding={session.isSpeeding}
          limitIsDefault={session.limitIsDefault}
          showLimit={settings.showSpeedLimit}
          gpsStatus={session.gpsStatus}
        />
        <PointsCard
          points={shownPoints}
          label={settings.displayTotalPoints ? 'Lifetime points' : 'Points this drive'}
          state={pointsState}
          pausedReason="Paused · alert"
        />
        <ConditionsStrip weather={session.weather} roadSummary={session.roadSummary} />
      </View>

      <View onLayout={(e) => setEndButtonHeight(e.nativeEvent.layout.height)}>
        {endState === 'sosFailed' ? (
          <View style={{ gap: 10 }}>
            <Banner
              tone="danger"
              icon="cloud-offline-outline"
              title="Couldn't clear your SOS alert"
              body="Your drive is saved. Retry now, or continue and clear it later from Family."
            />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Button title="Retry" onPress={retryClearSos} />
              </View>
              <View style={{ flex: 1 }}>
                <Button title="Continue" variant="ghost" onPress={() => goToSummary(summaryRef.current)} />
              </View>
            </View>
          </View>
        ) : (
          <>
            <HoldToEndButton onComplete={endDrive} disabled={ended} />
            {ended && (
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 10 }}>
                <Ionicons name="hourglass-outline" size={14} color={t.colors.textMuted} />
                <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>Saving your drive…</Text>
              </View>
            )}
          </>
        )}
      </View>

      <EmergencySheet
        visible={sosOpen}
        onClose={() => setSosOpen(false)}
        contacts={emergency.trustedContacts}
        hasGroup={!!groupId}
        busy={emergency.busy}
        isEmergencyActive={emergency.isEmergencyActive}
        onCall911={() => {
          setSosOpen(false);
          callNumber('911');
        }}
        onNotifyGroup={async () => {
          // The sheet stays open (busy) until the alert is confirmed sent.
          const ok = await emergency.notifyGroup();
          if (ok) setSosOpen(false);
        }}
        onCancelEmergency={async () => {
          const ok = await emergency.cancelGroupEmergency();
          if (ok) setSosOpen(false);
        }}
        onCallContact={(phone) => {
          setSosOpen(false);
          callNumber(phone);
        }}
      />

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

// DriveScreen — the live drive, designed for glanceability: one huge speed,
// the limit sign, points and a one-line road summary. Audio-first alerts, no
// modals, keep-awake, hold-to-end. The engine lives in hooks/useDriveSession.
//
// ============================================================================
// MONITORING MOUNT POINTS (docs/UX_REWORK.md §5.3)
//   [MP-1] status pill        → DriveTopBar (components/drive/DriveTopBar.js)
//   [MP-2] alert slot         → <AlertSlot/> below the top bar
//   [MP-3] critical overlay   → <CriticalOverlay/> last child of the root view
//   [MP-4] metrics in record  → finalize({ monitoring: … }) in endDrive()
//   [MP-5] points pause       → useDriveSession({ pausePoints })
// The real hook replaces monitoring/useDriverMonitoring.js; nothing here changes.
// ============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, BackHandler, Platform, ToastAndroid } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { Ionicons } from '@expo/vector-icons';

import { useTheme, Banner } from '../theme';
import { useSettings } from '../context/SettingsContext';
import { useAuthContext } from '../context/AuthContext';
import { useDriveSession } from '../hooks/useDriveSession';
import { useEmergency, callNumber } from '../hooks/useEmergency';
import { useDriverMonitoring } from '../monitoring/useDriverMonitoring';
import { useAlertAudio } from '../monitoring/alertAudio';
import { ALERT_SEVERITY, alertCopy } from '../monitoring/types';
import { monitoringSettingsFrom } from '../monitoring/settings';
import { CalibrationGate, shouldShowCalibrationGate } from '../components/monitoring/CalibrationGate';
import { AlertBanner } from '../components/monitoring/AlertBanner';
import { CriticalOverlay } from '../components/monitoring/CriticalOverlay';
import { SpeedHero, PointsCard, ConditionsStrip, HoldToEndButton, EmergencySheet, DriveTopBar } from '../components/drive';

const alertTone = require('../assets/sounds/alert.mp3');

export default function DriveScreen({ navigation, route }) {
  useKeepAwake();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { settings } = useSettings();
  const { points: lifetimePoints, groupId } = useAuthContext();
  const player = useAudioPlayer(alertTone);

  const monitoringEnabled = route.params?.monitoringEnabled ?? settings.monitoringEnabled;
  const [ended, setEnded] = useState(false);
  const [sosOpen, setSosOpen] = useState(false);
  const endingRef = useRef(false);

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  }, []);

  // ---- monitoring (mock until the monitoring branch lands) ----------------
  const monitoring = useDriverMonitoring({
    enabled: monitoringEnabled,
    driveActive: !ended,
    settings: monitoringSettingsFrom(settings),
    demo: !!route.params?.demoMonitoring,
  });
  const criticalActive = monitoring.activeAlert?.severity === ALERT_SEVERITY.CRITICAL;

  // ---- drive engine --------------------------------------------------------
  const goToSummary = useCallback(
    (summary) => {
      if (!summary) return;
      navigation.replace('DriveSummary', { summary });
    },
    [navigation]
  );
  const session = useDriveSession({
    active: !ended,
    unit: settings.speedUnit,
    showSpeedLimit: settings.showSpeedLimit,
    audioSpeedUpdatesEnabled: settings.audioSpeedUpdatesEnabled,
    speedingWarningsEnabled: settings.speedingWarningsEnabled,
    distractedNotificationsEnabled: settings.distractedNotificationsEnabled,
    notifyDriveComplete: settings.notifyDriveComplete,
    voiceAlerts: settings.monitoringVoiceAlerts,
    pausePoints: criticalActive, // [MP-5]
    onAutoEnd: (summary) => {
      setEnded(true);
      goToSummary(summary);
    },
  });
  const emergency = useEmergency();

  // ---- alert precedence ----------------------------------------------------
  // Display: monitoring INFO/WARNING > speeding > phone use. CRITICAL goes to the overlay.
  const monitoringBanner = useMemo(() => {
    const a = monitoring.activeAlert;
    if (!a || a.severity === ALERT_SEVERITY.CRITICAL) return null;
    const copy = alertCopy(a.type);
    return { id: a.id, severity: a.severity, title: a.title || copy.title, message: a.message || copy.message, icon: copy.icon };
  }, [monitoring.activeAlert]);
  const bannerAlert = monitoringBanner || session.speedingAlert || session.phoneAlert;

  // Audio: the highest-priority audible alert, following the one policy.
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
  const endDrive = useCallback(async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    setEnded(true);
    if (emergency.isEmergencyActive) await emergency.cancelGroupEmergency();
    // [MP-4] monitoring metrics into the drive record
    const summary = await session.finalize({
      monitoring: {
        enabled: monitoringEnabled,
        metrics: monitoring.metrics,
        calibrationState: monitoring.calibration?.state,
      },
    });
    goToSummary(summary);
  }, [emergency, session, monitoring.metrics, monitoring.calibration?.state, monitoringEnabled, goToSummary]);

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
  const shownPoints = settings.displayTotalPoints ? lifetimePoints + session.points : session.points;

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg, paddingTop: insets.top + 8, paddingHorizontal: 18, paddingBottom: Math.max(insets.bottom, 16) }}>
      <DriveTopBar
        onSos={() => setSosOpen(true)}
        monitoring={monitoring}
        monitoringEnabled={monitoringEnabled}
        elapsed={session.elapsed}
        onPillPress={monitoringEnabled ? monitoring.recalibrate : undefined}
      />

      {/* MONITORING MOUNT POINT [MP-2]: alert slot (calibration gate or INFO/WARNING banner) */}
      <View style={{ minHeight: 64, justifyContent: 'center', marginTop: 12 }}>
        {monitoringEnabled && shouldShowCalibrationGate(monitoring.calibration) && !bannerAlert ? (
          <CalibrationGate calibration={monitoring.calibration} onRecalibrate={monitoring.recalibrate} compact />
        ) : bannerAlert ? (
          <AlertBanner alert={bannerAlert} />
        ) : emergency.isEmergencyActive ? (
          <Banner tone="danger" icon="alert-circle" title="Emergency alert sent" body="Your group can see your location" />
        ) : session.gpsStatus === 'denied' ? (
          <Banner tone="danger" icon="navigate" title="Location is off" body="Enable location to track this drive" />
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

      <HoldToEndButton onComplete={endDrive} disabled={ended} />
      {ended && (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 10 }}>
          <Ionicons name="hourglass-outline" size={14} color={t.colors.textMuted} />
          <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>Saving your drive…</Text>
        </View>
      )}

      <EmergencySheet
        visible={sosOpen}
        onClose={() => setSosOpen(false)}
        contacts={emergency.trustedContacts}
        hasGroup={!!groupId}
        isEmergencyActive={emergency.isEmergencyActive}
        onCall911={() => {
          setSosOpen(false);
          callNumber('911');
        }}
        onNotifyGroup={async () => {
          setSosOpen(false);
          await emergency.notifyGroup();
        }}
        onCancelEmergency={async () => {
          setSosOpen(false);
          await emergency.cancelGroupEmergency();
        }}
        onCallContact={(phone) => {
          setSosOpen(false);
          callNumber(phone);
        }}
      />

      {/* MONITORING MOUNT POINT [MP-3]: full-screen CRITICAL overlay */}
      <CriticalOverlay alert={monitoring.activeAlert ? { ...monitoring.activeAlert, icon: alertCopy(monitoring.activeAlert.type).icon } : null} />
    </View>
  );
}

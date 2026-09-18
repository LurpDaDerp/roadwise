// Every AsyncStorage key the app uses, in one place. Existing keys keep their
// historical names so stored preferences survive the UX rework.
export const KEYS = {
  // Driving preferences (DriveScreenSettings)
  speedUnit: '@speedUnit',
  speedingWarningsEnabled: '@speedingWarningsEnabled',
  showSpeedLimit: '@showSpeedLimit',
  displayTotalPoints: '@displayTotalPoints',
  distractedNotificationsEnabled: '@distractedNotificationsEnabled',
  audioSpeedUpdatesEnabled: '@audioSpeedUpdatesEnabled',
  // Appearance (ThemeContext)
  appTheme: '@appTheme',
  // Notifications
  notifyDriveComplete: '@notify.driveComplete',
  notifyFamilyEmergency: '@notify.familyEmergency',
  // Driver monitoring (see monitoring/settings.js)
  monitoringEnabled: '@monitoring.enabled',
  monitoringVoiceAlerts: '@monitoring.voiceAlerts',
  monitoringToneAlerts: '@monitoring.toneAlerts',
  monitoringHapticAlerts: '@monitoring.hapticAlerts',
  monitoringSensitivity: '@monitoring.sensitivity',
  monitoringDriverSide: '@monitoring.driverSide',
  // Kept so a previously stored value is still readable; nothing writes it any more (the native
  // module renders no preview, so the setting was inert).
  monitoringShowPreview: '@monitoring.showPreview',
  // Caches and flags
  speedLimitCache: '@speedLimitCache',
  safetyScore: 'safetyScore', // legacy, device-global (pre-rework)
  safetyScoreFor: (uid) => `@safetyScore_${uid}`,
  feedbackCache: 'feedbackCache',
  cachedProfileImage: 'cachedProfileImage',
  onboarded: (uid) => `@onboarded_${uid}`,
};

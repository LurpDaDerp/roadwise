// Driver-monitoring settings: defaults and the option lists shown in Settings.

// MONITORING_AVAILABLE — false while monitoring/useDriverMonitoring.js is the
// mock. The camera-based monitoring branch flips this to true when it replaces
// the hook. While false: the toggles read "Coming soon", no camera permission
// is requested, the status pill and calibration gate stay hidden, and no
// monitoring data is written to drive records.
export const MONITORING_AVAILABLE = false;
export const MONITORING_DEFAULTS = Object.freeze({
  monitoringEnabled: false,
  monitoringVoiceAlerts: true,
  monitoringToneAlerts: true,
  monitoringHapticAlerts: true,
  monitoringSensitivity: 'medium', // 'low' | 'medium' | 'high'
  monitoringDriverSide: 'left',     // 'left' | 'right' — which side of the car the driver sits on
  monitoringShowPreview: false,
});

export const SENSITIVITY_OPTIONS = [
  { value: 'low', label: 'Relaxed', body: 'Fewer alerts; only clear distractions.' },
  { value: 'medium', label: 'Balanced', body: 'Recommended for most drivers.' },
  { value: 'high', label: 'Strict', body: 'Earlier, more frequent alerts.' },
];

export const DRIVER_SIDE_OPTIONS = [
  { value: 'left', label: 'Left', body: 'US, Canada, EU and most countries.' },
  { value: 'right', label: 'Right', body: 'UK, Japan, Australia, India.' },
];

// Shape passed to useDriverMonitoring({ settings }).
export function monitoringSettingsFrom(settings) {
  return {
    sensitivity: settings.monitoringSensitivity,
    driverSide: settings.monitoringDriverSide,
    showPreview: !!settings.monitoringShowPreview,
    voiceAlerts: !!settings.monitoringVoiceAlerts,
    toneAlerts: !!settings.monitoringToneAlerts,
    hapticAlerts: !!settings.monitoringHapticAlerts,
  };
}

// Driver-monitoring settings: defaults and the option lists shown in Settings.

// MONITORING_AVAILABLE — the kill switch for the whole camera feature. It is TRUE: the real
// camera + gaze + rule-engine hook replaced the mock. Setting it back to false makes the
// toggles read "Coming soon", asks for no camera permission, hides the status pill and the
// calibration gate, and writes no monitoring data to drive records.
export const MONITORING_AVAILABLE = true;
export const MONITORING_DEFAULTS = Object.freeze({
  monitoringEnabled: false,
  monitoringVoiceAlerts: true,
  monitoringToneAlerts: true,
  monitoringHapticAlerts: true,
  monitoringSensitivity: 'medium', // 'low' | 'medium' | 'high'
  monitoringDriverSide: 'left',     // 'left' | 'right' — which side of the car the driver sits on
  // No monitoringShowPreview: the native module has no preview view, so the toggle was inert
  // (docs/dms/INTEGRATION.md §3, previewComponent is always null). monitoringSettingsFrom()
  // keeps reading the key so a stored value survives until a preview exists.
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

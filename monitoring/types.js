// Driver-monitoring contract — shared enums and copy.
// The camera-based monitoring branch must emit these values; the UI in
// components/monitoring/* renders them. See docs/UX_REWORK.md §5.
//
// EXTENDED by the driver-monitoring branch (docs/dms/INTEGRATION.md): four alert types the
// rule engine can raise and the UX branch did not have (SEVERE_DROWSY, EYES_NOT_VISIBLE,
// FIXED_GAZE, NO_MIRROR_CHECK), the corrected PROLONGED_STARE copy (in the reference it is a
// glance away that persists 3 s past its limit, not a cognitive stare), and an optional
// `sound` per type for a future extension of alertAudio.js.  Every existing name and value is
// unchanged.

export const ALERT_SEVERITY = Object.freeze({
  INFO: 'info',          // displayed only, never audible
  WARNING: 'warning',    // audible once (tone or spoken phrase)
  CRITICAL: 'critical',  // audible and repeating while it persists
});

export const ALERT_TYPE = Object.freeze({
  OFF_ROAD_GLANCE: 'OFF_ROAD_GLANCE',
  LONG_GLANCE: 'LONG_GLANCE',
  EYES_OFF_ROAD_ACCUMULATED: 'EYES_OFF_ROAD_ACCUMULATED',
  PHONE_GLANCE: 'PHONE_GLANCE',
  HEAD_DOWN: 'HEAD_DOWN',
  HEAD_TURNED: 'HEAD_TURNED',
  EYES_CLOSED: 'EYES_CLOSED',
  MICROSLEEP: 'MICROSLEEP',
  PERCLOS: 'PERCLOS',
  YAWNING: 'YAWNING',
  HEAD_NOD: 'HEAD_NOD',
  DROWSY: 'DROWSY',
  SEVERE_DROWSY: 'SEVERE_DROWSY',
  PROLONGED_STARE: 'PROLONGED_STARE',
  NO_FACE: 'NO_FACE',
  EYES_NOT_VISIBLE: 'EYES_NOT_VISIBLE',
  FIXED_GAZE: 'FIXED_GAZE',
  NO_MIRROR_CHECK: 'NO_MIRROR_CHECK',
});

export const CALIBRATION_STATE = Object.freeze({
  OFF: 'off',
  CALIBRATING: 'calibrating',   // first ~1–2 minutes: learning "looking forward"
  PROVISIONAL: 'provisional',   // usable estimate, still refining
  CONFIRMED: 'confirmed',
  LOST: 'lost',                 // camera moved or driver changed; re-calibrating
});

export const MONITOR_STATUS = Object.freeze({
  OFF: 'off',
  STARTING: 'starting',
  CALIBRATING: 'calibrating',
  ACTIVE: 'active',
  NO_FACE: 'no_face',
  CAMERA_ERROR: 'camera_error',
  PERMISSION_DENIED: 'permission_denied',
});

// Title, banner message, spoken phrase, icon (Ionicons) and tone name per alert type.
// `sound` names a WAV in assets/sounds/dms/ (siren / double_high / double_low / single_low);
// alertAudio.js does not use it yet — it plays one tone and distinguishes by the phrase.
export const ALERT_COPY = Object.freeze({
  OFF_ROAD_GLANCE: { title: 'Eyes off the road', message: 'Glance detected', speech: 'Eyes on the road', icon: 'eye-off-outline', sound: 'double_high' },
  LONG_GLANCE: { title: 'Long glance', message: 'Look back at the road', speech: 'Look at the road', icon: 'eye-off-outline', sound: 'double_high' },
  EYES_OFF_ROAD_ACCUMULATED: { title: 'Too much time off the road', message: 'Keep your eyes forward', speech: 'Keep your eyes on the road', icon: 'eye-off-outline', sound: 'double_high' },
  PHONE_GLANCE: { title: 'Phone glance', message: 'Put the phone down', speech: 'Phone down, eyes up', icon: 'phone-portrait-outline', sound: 'double_high' },
  HEAD_DOWN: { title: 'Head down', message: 'Look up', speech: 'Look up', icon: 'arrow-down-circle-outline', sound: 'double_high' },
  HEAD_TURNED: { title: 'Head turned', message: 'Face forward', speech: 'Face forward', icon: 'return-up-back-outline', sound: 'double_high' },
  EYES_CLOSED: { title: 'Eyes closed', message: 'Wake up', speech: 'Wake up. Eyes open.', icon: 'alert-circle-outline', sound: 'siren' },
  MICROSLEEP: { title: 'Microsleep', message: 'Pull over safely', speech: 'Wake up. Pull over when safe.', icon: 'alert-circle-outline', sound: 'siren' },
  PERCLOS: { title: 'Drowsiness', message: 'You look tired — take a break', speech: 'You seem drowsy. Consider a break.', icon: 'bed-outline', sound: 'double_low' },
  YAWNING: { title: 'Yawning', message: 'Feeling tired?', speech: null, icon: 'bed-outline', sound: 'double_low' },
  HEAD_NOD: { title: 'Head nod', message: 'Stay alert', speech: 'Stay alert', icon: 'bed-outline', sound: 'double_low' },
  DROWSY: { title: 'Drowsy', message: 'Take a break soon', speech: 'You seem drowsy. Take a break soon.', icon: 'bed-outline', sound: 'double_low' },
  SEVERE_DROWSY: { title: 'Severe drowsiness', message: 'Pull over and rest', speech: 'You are very drowsy. Pull over when safe.', icon: 'bed-outline', sound: 'siren' },
  PROLONGED_STARE: { title: 'Eyes off the road', message: 'Look back at the road now', speech: 'Look at the road now', icon: 'eye-off-outline', sound: 'double_high' },
  NO_FACE: { title: 'Driver not visible', message: 'Adjust the phone mount', speech: null, icon: 'videocam-off-outline', sound: 'single_low' },
  EYES_NOT_VISIBLE: { title: 'Eyes not visible', message: 'Head-only monitoring', speech: null, icon: 'glasses-outline', sound: null },
  FIXED_GAZE: { title: 'Fixed stare', message: 'Stay engaged — check your mirrors', speech: null, icon: 'scan-outline', sound: 'double_high' },
  NO_MIRROR_CHECK: { title: 'No mirror check', message: 'Scan your mirrors', speech: null, icon: 'car-outline', sound: 'double_high' },
});

export const DROWSINESS_LABELS = ['Alert', 'Slightly tired', 'Tired', 'Drowsy'];

export function alertCopy(type) {
  return ALERT_COPY[type] || { title: 'Attention', message: '', speech: null, icon: 'alert-circle-outline', sound: null };
}

// Driver-monitoring contract — shared enums and copy.
// The camera-based monitoring branch must emit these values; the UI in
// components/monitoring/* renders them. See docs/UX_REWORK.md §5.

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
  PROLONGED_STARE: 'PROLONGED_STARE',
  NO_FACE: 'NO_FACE',
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

// Title, banner message, spoken phrase and icon (Ionicons) per alert type.
export const ALERT_COPY = Object.freeze({
  OFF_ROAD_GLANCE: { title: 'Eyes off the road', message: 'Glance detected', speech: 'Eyes on the road', icon: 'eye-off-outline' },
  LONG_GLANCE: { title: 'Long glance', message: 'Look back at the road', speech: 'Look at the road', icon: 'eye-off-outline' },
  EYES_OFF_ROAD_ACCUMULATED: { title: 'Too much time off the road', message: 'Keep your eyes forward', speech: 'Keep your eyes on the road', icon: 'eye-off-outline' },
  PHONE_GLANCE: { title: 'Phone glance', message: 'Put the phone down', speech: 'Phone down, eyes up', icon: 'phone-portrait-outline' },
  HEAD_DOWN: { title: 'Head down', message: 'Look up', speech: 'Look up', icon: 'arrow-down-circle-outline' },
  HEAD_TURNED: { title: 'Head turned', message: 'Face forward', speech: 'Face forward', icon: 'return-up-back-outline' },
  EYES_CLOSED: { title: 'Eyes closed', message: 'Wake up', speech: 'Wake up. Eyes open.', icon: 'alert-circle-outline' },
  MICROSLEEP: { title: 'Microsleep', message: 'Pull over safely', speech: 'Wake up. Pull over when safe.', icon: 'alert-circle-outline' },
  PERCLOS: { title: 'Drowsiness', message: 'You look tired — take a break', speech: 'You seem drowsy. Consider a break.', icon: 'bed-outline' },
  YAWNING: { title: 'Yawning', message: 'Feeling tired?', speech: null, icon: 'bed-outline' },
  HEAD_NOD: { title: 'Head nod', message: 'Stay alert', speech: 'Stay alert', icon: 'bed-outline' },
  DROWSY: { title: 'Drowsy', message: 'Take a break soon', speech: 'You seem drowsy. Take a break soon.', icon: 'bed-outline' },
  PROLONGED_STARE: { title: 'Prolonged stare', message: 'Check your mirrors', speech: 'Stay engaged. Check your mirrors.', icon: 'scan-outline' },
  NO_FACE: { title: 'Driver not visible', message: 'Adjust the phone mount', speech: null, icon: 'videocam-off-outline' },
});

export const DROWSINESS_LABELS = ['Alert', 'Slightly tired', 'Tired', 'Drowsy'];

export function alertCopy(type) {
  return ALERT_COPY[type] || { title: 'Attention', message: '', speech: null, icon: 'alert-circle-outline' };
}

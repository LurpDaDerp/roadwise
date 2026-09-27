// Every string of the camera beta (lean M7, lane B): the A10 onboarding step, the settings screen, the HUD chip,
// the spoken alert lines and the trip's "Camera coaching" card. One place, so the consent text and the screens can
// never say different things about what the camera does.
import type { AlertKind, DmsHudStatus } from '@/core/dms';

/**
 * The consent the driver gives, word for word; `CAMERA_CONSENT_VERSION` (optIn.ts) names this text. Change it only
 * with a new version: a driver who agreed to the old words is asked again.
 */
export const cameraConsent = {
  title: 'Camera coaching (beta)',
  lead: 'RoadWise can use the front camera to warn you if you look away from the road too long or start to nod off.',
  points: [
    'It looks for your face, eyes and head angle, and nothing else.',
    'Everything stays on this phone. No photos or video are ever saved or uploaded.',
    'It learns where you look on the road by itself as you drive. There is no setup.',
    'Sleep and distraction alerts need RoadWise open on screen, with the phone mounted in a holder.',
    'Mount the phone below your line of sight to the road, not above it.',
    'A trip ends where you stopped driving. Nothing after you stop driving is uploaded.',
  ],
  footnote: 'It is a beta: it can miss things, and it never replaces staying alert. Turn it off any time in Settings.',
} as const;

export const cameraCopy = {
  step: {
    turnOn: 'Turn on camera coaching',
    notNow: 'Not now',
    continue: 'Continue',
    on: 'Camera coaching is on.',
    notAvailableAge: 'Camera coaching is for drivers 18 and over.',
    notAvailableFlag: 'Camera coaching is not available on this account yet.',
    failed: "Couldn't turn it on. Check your connection and try again.",
    permissionDenied: 'Camera access is off. You can allow it in Settings; coaching stays off until you do.',
  },
  settings: {
    title: 'Camera coaching',
    switchLabel: 'Camera coaching (beta)',
    switchHint: 'Warns you about long looks away and signs of sleep while you drive.',
    offNote: 'Off. The camera is never used.',
    onNote: 'On. The camera runs only during a mounted drive, with RoadWise open.',
    permissionNote: 'RoadWise asks for camera access at the start of your next mounted drive.',
    seatLabel: "Driver's seat",
    seatHint: 'Helps the camera tell when you get out of the car.',
    seatLeft: 'Left',
    seatRight: 'Right',
    whatItDoes: 'What it does',
    failed: "Couldn't save that. Check your connection and try again.",
  },
  chip: {
    starting: 'Camera starting',
    watching: 'Camera on',
    sleepOnly: 'Stopped: watching for sleep only',
    heat: 'Camera paused: phone too hot',
    dark: 'Too dark to see you',
    absent: 'No one in the seat',
    face: "Can't see your face",
    eyes: "Can't see your eyes",
    learning: 'Learning your eyes',
    recalibrating: 'Adjusting to your position',
    speedUnknown: 'Speed unknown',
    interrupted: 'Camera interrupted',
    busy: 'Camera in use by diagnostics',
    permission: 'Camera access off',
    error: 'Camera unavailable this drive',
  },
  coaching: {
    title: 'Camera coaching',
    beta: 'Beta',
    seen: (pct: number) => `Camera saw you for ${pct}% of the drive`,
    longGlances: (n: number) => (n === 1 ? '1 look away over 2 s' : `${n} looks away over 2 s`),
    longestGlance: (s: number) => `Longest look away: ${s.toFixed(1)} s`,
    distractionAlerts: (n: number) => (n === 1 ? '1 distraction alert' : `${n} distraction alerts`),
    sleepAlerts: (n: number) => (n === 1 ? '1 sleep alert' : `${n} sleep alerts`),
    clean: 'Eyes on the road the whole way. Nice.',
    limited: 'The camera had trouble seeing you on this drive; mount the phone facing you, below the road line.',
    tipGlances: 'Try to keep looks away under 2 seconds: at 60 km/h that is over 30 m of road unseen.',
    tipSleep: 'You showed signs of sleepiness. Take a break before your next drive.',
  },
} as const;

/** The words spoken with each alert kind (the tone comes from its tier). Short: they must fit a glance. */
export const cameraVoice: Readonly<Record<AlertKind, string>> = {
  distraction: 'Eyes on the road',
  cumulative: 'Eyes on the road',
  eyes_on_road: 'Eyes up',
  phone_pattern: 'Put the phone down',
  repeated_glances: 'Watch the road',
  unresponsive: 'Wake up. Pull over',
  microsleep: 'Wake up',
  microsleep_nod: 'Wake up',
  sleep: 'Wake up. Pull over',
  fatigue_early: 'Feeling tired? Plan a break',
  fatigue: 'Time for a break',
  monitoring_paused: 'Camera alerts paused',
};

/** The chip's words for a status, or null when there is nothing to show (the beta is off for this drive). */
export function chipLabel(s: DmsHudStatus): string | null {
  const c = cameraCopy.chip;
  if (s.camera === 'off') {
    if (s.reason === 'permission') return c.permission;
    if (s.reason === 'error') return c.error;
    if (s.reason === 'busy') return c.busy;
    return null;
  }
  if (s.camera === 'starting') return c.starting;
  if (s.camera === 'paused') {
    if (s.reason === 'thermal') return c.heat;
    if (s.reason === 'low_light') return c.dark;
    if (s.reason === 'absent') return c.absent;
    return c.interrupted;
  }
  switch (s.monitoring.reason) {
    case 'stopped':
      return c.sleepOnly;
    case 'heat':
      return c.heat;
    case 'dark':
      return c.dark;
    case 'absent':
      return c.absent;
    case 'face':
      return c.face;
    case 'eyes':
      return c.eyes;
    case 'learning_eyes':
      return c.learning;
    case 'recalibrating':
    case 'posture':
    case 'seed_check':
      return c.recalibrating;
    case 'speed_unknown':
      return c.speedUnknown;
    case 'camera':
      return c.interrupted;
    default:
      break;
  }
  if (s.camera === 'limited') return s.reason === 'eyes_not_visible' ? c.eyes : s.reason === 'low_light' ? c.dark : c.face;
  return c.watching;
}

/** The chip's tone: calm when watching, muted when limited or paused. */
export function chipTone(s: DmsHudStatus): 'on' | 'limited' {
  return s.camera === 'active' && (s.monitoring.reason === null || s.monitoring.reason === 'stopped') ? 'on' : 'limited';
}

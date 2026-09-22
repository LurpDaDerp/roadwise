/**
 * Every string the permission surfaces print: B2 (permission health), the Home banner, the
 * background-location disclosure's controls and the readiness test. The disclosure's own words
 * live in `src/features/drive/detectionCopy.ts` (the one disclosure module).
 *
 * Honesty (M2 rule): each line says only what the snapshot supports. Nothing here promises that
 * a drive will be detected, and nothing nags about a choice the driver made — an `info` row
 * explains; it never asks.
 */
import type {
  HealthReason,
  HealthRow,
  HealthRowId,
  HealthStatus,
  PermissionPlatform,
  PermissionSnapshot,
} from '@/core/permissions';

export const permissionsCopy = {
  title: 'Permission health',
  loading: 'Checking this phone',
  readError: {
    message: "Couldn't check this phone's permissions.",
    retry: 'Try again',
  },
  actionError: "That didn't work. Try again.",
  summary: {
    ok: 'Everything RoadWise needs is on',
    attention: 'Some things need attention',
    broken: "RoadWise can't record drives right now",
  },
  status: {
    ok: 'All set',
    attention: 'Needs attention',
    off: 'Off',
    info: 'Note',
  } satisfies Record<HealthStatus, string>,
  /** What an `info` row's status says, by why it is informational. */
  infoStatus: {
    choice: 'Your choice',
    notAvailable: 'Not available',
    afterFirstDrive: 'After your first drive',
    cantCheck: "Can't check",
    lapsed: 'Note',
    notAffirmed: 'Needs your OK',
  } satisfies Record<HealthReason, string>,
  fix: {
    location: 'Allow location',
    background: 'Allow background location',
    /** Always is already allowed on the phone; this account has not seen the disclosure. */
    review: 'Review background location',
    motion: 'Allow motion access',
    notifications: 'Allow notifications',
    openSettings: 'Open Settings',
    openBatterySettings: 'Open battery settings',
  },
  fixHint: {
    openSettings: 'Opens this app in your phone’s Settings',
    background: 'Explains background location before anything is asked',
    review: 'Shows how RoadWise uses background location, then turns auto-record on',
  },
  test: {
    run: 'Run a test',
    running: 'Checking',
    hint: 'Checks whether auto-record is armed on this phone right now',
    armed: 'Auto-record is armed on this phone right now.',
    allowedNotArmed: 'Auto-record isn’t armed right now, though this phone allows it.',
    notAllowed:
      'Auto-record isn’t armed. This phone doesn’t allow it yet: it needs background location and motion access.',
    cantCheck: 'We couldn’t check auto-record on this phone.',
  },
  banner: {
    recordingOff: 'Drive recording is off — tap to fix',
    locationLimited: 'Location access is limited — tap to fix',
    /** Auto-record wanted and allowed, but this account hasn't affirmed the disclosure (Task 19 r1). */
    autoRecordNeedsOk: 'Auto-record needs your OK to use background location — tap to review',
    /** Motion lost while the driver starts drives themselves (Ruling T8 r1 (3)). */
    motionManual: 'Motion access is off, so drives may not end on their own — tap to fix',
    motionAuto:
      'Motion access is off, so auto-record can’t start drives and drives may not end on their own — tap to fix',
    hint: 'Opens permission health',
  },
  disclosure: {
    continue: 'Continue',
    continueHint: 'Asks your phone for background location',
    /**
     * Shown before the tap on every entry whose Continue also turns auto-record on (Ruling T9 (2)):
     * the tap is the driver's opt-in, so the screen says so first.
     */
    autoRecordNote:
      'Continue also turns on auto-record: RoadWise will start recording your drives automatically.',
    autoRecordHint: 'Asks your phone for background location and turns on auto-record',
    notNow: 'Not now',
    notNowHint: 'Keeps starting drives yourself. Nothing is asked.',
    openSettings: 'Open Settings',
    settingsNeeded: {
      ios: 'Choose Always in Settings, then come back',
      android: 'Choose Allow all the time in Settings, then come back',
    } satisfies Record<PermissionPlatform, string>,
    /** iOS before the first completed drive: nothing is asked (design §5.3). */
    notYet: 'On iPhone, RoadWise asks for this after your first drive.',
    /** Always is only ever the step after While Using. */
    needsForeground: 'Allow location while using the app first. This is the step after it.',
    back: 'Back',
    requestError: 'Your phone didn’t answer. Try again.',
  },
} as const;

const TITLES: Record<HealthRowId, string | Record<PermissionPlatform, string>> = {
  location: 'Location',
  precise: 'Precise location',
  locationAlways: 'Background location',
  autoRecord: 'Auto-record',
  motion: { ios: 'Motion & Fitness', android: 'Physical activity' },
  notifications: 'Notifications',
  battery: 'Battery optimisation',
  lowPower: 'Low Power Mode',
};

export function rowTitle(id: HealthRowId, platform: PermissionPlatform): string {
  const title = TITLES[id];
  return typeof title === 'string' ? title : title[platform];
}

/** The short status word a row leads with, and the one screen readers hear first. */
export function rowStatus(row: HealthRow): string {
  if (row.status !== 'info') return permissionsCopy.status[row.status];
  if (row.reason) return permissionsCopy.infoStatus[row.reason];
  if (row.id === 'motion') return 'Not on this phone';
  if (row.id === 'lowPower') return 'On';
  return permissionsCopy.status.info;
}

export interface ConsequenceContext {
  snapshot: PermissionSnapshot;
  /**
   * The driver wants drives to start on their own and the server offers it: auto-record chosen,
   * available, and not manual by choice. Decides whether motion copy mentions auto-record.
   */
  autoRecordWanted: boolean;
}

const CANT_CHECK = 'We can’t check this from here.';
const NOT_NEEDED_CHOICE = 'You’re starting drives yourself, so this isn’t needed.';
const NOT_NEEDED_WITHDRAWN = 'Auto-record isn’t available yet, so this isn’t needed.';

function excused(reason: HealthReason | undefined): string | null {
  if (reason === 'choice') return NOT_NEEDED_CHOICE;
  if (reason === 'notAvailable') return NOT_NEEDED_WITHDRAWN;
  if (reason === 'cantCheck') return CANT_CHECK;
  return null;
}

/** The one-line consequence under a row's title: what this state means for recording drives. */
export function rowConsequence(row: HealthRow, c: ConsequenceContext): string {
  const { status, reason } = row;
  const lapsed = reason === 'lapsed';
  switch (row.id) {
    case 'location':
      if (status === 'ok') return 'RoadWise can measure your drives.';
      if (status === 'off')
        return lapsed
          ? 'Location was turned off, so RoadWise can’t record drives.'
          : 'Without location, RoadWise can’t record drives.';
      return 'Not allowed yet, so RoadWise can’t record drives.';

    case 'precise':
      if (status === 'ok') return 'Speed and distance are measured accurately.';
      if (status === 'info') return CANT_CHECK;
      return 'Approximate location makes speed and distance less accurate.';

    case 'locationAlways':
      if (status === 'ok') return 'RoadWise can use location while the app is closed.';
      if (status === 'info') {
        if (reason === 'afterFirstDrive') return 'On iPhone, RoadWise asks for this after your first drive.';
        return excused(reason) ?? NOT_NEEDED_CHOICE;
      }
      return lapsed
        ? 'Background location was turned off, so auto-record can’t start drives.'
        : 'Auto-record needs this to start drives while the app is closed.';

    case 'autoRecord': {
      if (status === 'ok') return 'Turned on, and this phone allows it.';
      if (status === 'info') {
        if (reason === 'afterFirstDrive') return 'On iPhone, auto-record can be turned on after your first drive.';
        if (reason === 'notAvailable') return 'Auto-record isn’t available yet. Tap Start drive whenever you drive.';
        return 'You start drives yourself with Start drive.';
      }
      if (reason === 'notAffirmed') {
        return 'Turned on, but it can’t start drives until you review how RoadWise uses background location.';
      }
      const blocker = c.snapshot.location === 'always' ? 'motion access' : 'background location';
      return `Turned on, but it needs ${blocker} to start drives.`;
    }

    case 'motion': {
      if (status === 'ok') return 'Helps tell driving apart from walking.';
      if (status === 'info') return reason === 'cantCheck' ? CANT_CHECK : 'This phone has no motion sensing RoadWise can use.';
      const lead =
        status === 'attention'
          ? 'Not allowed yet, so '
          : lapsed
            ? 'Motion access was turned off, so '
            : 'Motion access is off, so ';
      return c.autoRecordWanted
        ? `${lead}auto-record can’t start drives and drives may not end on their own.`
        : `${lead}drives may not end on their own.`;
    }

    case 'notifications':
      if (status === 'ok') return 'You’ll see drive summaries and notices.';
      return status === 'off'
        ? 'Off. Updates wait in your Inbox instead.'
        : 'Not allowed yet. Updates wait in your Inbox instead.';

    case 'battery':
      if (status === 'ok') return 'Your phone lets RoadWise run in the background.';
      if (status === 'info') return excused(reason) ?? CANT_CHECK;
      return 'Your phone may stop RoadWise in the background, so drives may be missed.';

    case 'lowPower':
      if (status === 'ok') return 'Low Power Mode is off.';
      if (reason === 'cantCheck') return CANT_CHECK;
      return 'While it’s on, drives may be recorded in less detail.';
  }
}

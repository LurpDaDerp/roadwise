/**
 * A tap on the forgot-to-start reminder's notification: the one way the reminder leads to a drive.
 * The tap is the driver's explicit action (as the Start Drive tap is); nothing else here, or in the
 * reminder, starts a drive.
 *
 * The note carries a one-use token. iOS hands the tap to JS as a notification response
 * (`reminderTokenOf`); Android hands it over natively, once (`watchReminderTapIntents`). Either way
 * the hold is run by `startFromReminderTap`: it waits while the app cannot start a drive yet (a slow
 * cold start), asks native to claim the token (true once, for the live note, while its session lasts
 * and no drive is open), and only then starts the drive through the same `start` the Start Drive
 * button uses, at any speed. A tap held more than `REMINDER.TAP_FRESH_MS` (2 min) is expired. A tap
 * that cannot start a drive lands on Home with the same line the Start Drive button shows, or "That
 * reminder has expired". A tap during setup, while signed out or with an update required starts
 * nothing and shows nothing.
 *
 * A drive under way settles a tap at once, before any other rule and whatever its age: the note's
 * token went when that drive started, so no claim could succeed. While the drive records the tap
 * opens the drive screen; while it closes it does nothing (its summary or Home follows). Either way
 * the hold is spent, so it can never act after the drive ends.
 */
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';

import DriveSense, { REMINDER, REMINDER_TOKEN, type DriveSenseApi, type ReminderTap } from '@drive-sense';

import type { AppStateLike } from '@/data/foreground';
import type { StartResult } from '@/drive/host';
import type { StartNotice } from '@/features/home/startNotice';

/** The reminder note's identifier on iOS (one note, replaced). */
export const REMINDER_NOTIFICATION_ID = 'roadwise.tripReminder';

const HOME = '/home';
const DRIVE = '/drive';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function requestOf(response: unknown): Record<string, unknown> | null {
  if (!isRecord(response) || !isRecord(response.notification)) return null;
  const request = response.notification.request;
  return isRecord(request) ? request : null;
}

/** A response that is the reminder's at all (by its identifier), token or not: never routed as a link. */
export function isReminderResponse(response: unknown): boolean {
  return requestOf(response)?.identifier === REMINDER_NOTIFICATION_ID;
}

/** The reminder's token from a tap on it; null for anything else (another note, a button, a dismissal). */
export function reminderTokenOf(response: unknown): string | null {
  if (!isReminderResponse(response) || !isRecord(response)) return null;
  if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return null;
  const content = requestOf(response)?.content;
  const data = isRecord(content) ? content.data : null;
  if (!isRecord(data) || data.kind !== 'tripReminder') return null;
  const token = data.reminderToken;
  return typeof token === 'string' && REMINDER_TOKEN.test(token) ? token : null;
}

/**
 * Whether a held tap may start a drive now, must wait (the app is still starting), or never will;
 * or a drive is under way: `driving` (recording) or `closing` (finalizing).
 */
export type StartGate = 'yes' | 'wait' | 'never' | 'driving' | 'closing';

export interface StartGateFacts {
  /** The navigator is mounted. */
  ready: boolean;
  session: 'loading' | 'signedOut' | 'signedIn';
  /** The minimum-version gate; null until the config cache was read. */
  update: 'required' | 'ok' | 'unknown' | null;
  profile: 'unknown' | 'onboarding' | 'ready';
  hostBooted: boolean;
  hostSignedIn: boolean;
  /** A drive is under way (recording or finalizing). */
  hostBusy: boolean;
  /** A drive is recording. */
  hostRecording: boolean;
}

export function reminderStartGate(f: StartGateFacts): StartGate {
  if (!f.ready) return 'wait';
  // A drive under way comes before every other rule, as a relaunch into an open drive does.
  if (f.hostBusy) return f.hostRecording ? 'driving' : 'closing';
  if (f.session === 'loading') return 'wait';
  if (f.session === 'signedOut') return 'never';
  if (f.update === null) return 'wait';
  if (f.update === 'required') return 'never';
  if (f.profile === 'unknown') return 'wait';
  if (f.profile === 'onboarding') return 'never';
  if (!f.hostBooted || !f.hostSignedIn) return 'wait';
  return 'yes';
}

export type ReminderTapNative = Pick<DriveSenseApi, 'claimReminderTap' | 'takeReminderTap' | 'addListener'>;

export interface ReminderTapDeps {
  /** The host's start, the Start Drive button's; nothing else may be passed here. */
  start(): Promise<StartResult>;
  navigate(href: string): void;
  /** Shown on Home (the start notice). */
  notice(n: StartNotice): void;
  gate(): StartGate;
  now(): number;
  native?: Pick<ReminderTapNative, 'claimReminderTap'>;
  onError?(e: unknown, ctx: string): void;
}

/**
 * dropped: never (setup, signed out, update required); waiting: keep the hold; stale: expired or not
 * claimed; busy: a drive under way (the drive screen while it records, nothing while it closes).
 */
export type TapOutcome = 'started' | 'refused' | 'stale' | 'dropped' | 'waiting' | 'busy';

/** Runs a held tap if the app can start a drive now. The only caller of `start` for a reminder. */
export async function startFromReminderTap(hold: ReminderTap, deps: ReminderTapDeps): Promise<TapOutcome> {
  const gate = deps.gate();
  if (gate === 'never') return 'dropped';
  // Before the age check: a drive under way never sends the driver to Home with "expired".
  if (gate === 'driving') {
    deps.navigate(DRIVE);
    return 'busy';
  }
  if (gate === 'closing') return 'busy';
  const expired = (): TapOutcome => {
    deps.notice('reminder-expired');
    deps.navigate(HOME);
    return 'stale';
  };
  if (deps.now() - hold.at > REMINDER.TAP_FRESH_MS) return expired();
  if (gate === 'wait') return 'waiting';
  let claimed = false;
  try {
    claimed = await (deps.native ?? DriveSense).claimReminderTap(hold.token);
  } catch (e) {
    deps.onError?.(e, 'reminder.claim');
  }
  if (!claimed) return expired();
  try {
    const r = await deps.start();
    if (r.ok) {
      deps.navigate(DRIVE);
      return 'started';
    }
    if (r.reason === 'busy') {
      deps.navigate(DRIVE);
      return 'refused';
    }
    deps.notice(r.reason);
  } catch (e) {
    deps.onError?.(e, 'reminder.start');
    deps.notice('error');
  }
  deps.navigate(HOME);
  return 'refused';
}

/**
 * Android: the taps native hands over (each token once). Takes one now, on each `reminderTap` event
 * and each return to the front. iOS: native never holds one, so this yields nothing.
 */
export function watchReminderTapIntents(
  onTap: (hold: ReminderTap) => void,
  native: Pick<ReminderTapNative, 'takeReminderTap' | 'addListener'> = DriveSense,
  appState: AppStateLike = AppState
): () => void {
  let live = true;
  const take = () => {
    native
      .takeReminderTap()
      .then((tap) => {
        if (live && tap) onTap(tap);
      })
      .catch(() => {
        // No native module (Expo Go, tests): nothing to take.
      });
  };
  take();
  const event = native.addListener('reminderTap', take);
  const app = appState.addEventListener('change', (s) => {
    if (s === 'active') take();
  });
  return () => {
    live = false;
    event.remove();
    app.remove();
  };
}

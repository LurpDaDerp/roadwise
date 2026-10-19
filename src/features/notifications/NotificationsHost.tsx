/**
 * The app's only notification response listener (rev1: C1 — one plumbing for local and pushed
 * notifications).
 *
 * On mount: the Android channels (`ensureNotificationSetup`), the one
 * foreground handler, the response listener, the tap that launched the app (read once with the
 * SDK 57 `getLastNotificationResponse`, then cleared so a remount does not act on it again). A tap
 * is acted on by `handleResponse`; one
 * that lands during a drive, or before the navigator is mounted, is held and replayed when the
 * drive's busy signal says it is over.
 *
 * A tap on the forgot-to-start reminder is never routed as a link: its token is held (iOS: from the
 * response; Android: handed over natively, `watchReminderTapIntents`) and run by
 * `startFromReminderTap`, which claims it natively and only then starts the drive through
 * `startDrive` — the Start Drive button's own start. It is tried on a new hold, on each change of
 * the busy signal, and whenever `startGate` changes; a hold waits while the app is still starting
 * (at most 2 min from the tap) and is dropped during setup, signed out or with an update required.
 * A drive under way spends it at once: the drive screen while it records, nothing while it closes.
 * The tap's routes go through `router.navigate`, so a tap while the drive screen shows never stacks
 * a second one on it; Home goes through `router.dismissTo` when a screen sits above the tabs, so it
 * returns to the Home already in the stack instead of opening a second one.
 *
 * Battery (§3.5): no timer and no polling. The busy subscription fires with the drive host's state
 * changes; while nothing is held it returns after one boolean read.
 *
 * Renders nothing. Mounted by the root layout inside `DataProvider` and the query client (Task 18),
 * which also removes M3's interim `useSummaryNotificationRouting`, so one tap navigates once.
 */
import * as Notifications from 'expo-notifications';
import { router, type Href } from 'expo-router';
import { useEffect, useLayoutEffect, useRef } from 'react';

import type { ReminderTap } from '@drive-sense';

import { useDataSource } from '@/data/queries';
import type { StartResult } from '@/drive/host';
import { clearStartNotice, showStartNotice } from '@/features/home/startNotice';

import { ensureNotificationSetup } from './categories';
import { installForegroundHandler } from './handler';
import {
  isReminderResponse,
  REMINDER_HOME_HREF,
  reminderTokenOf,
  startFromReminderTap,
  watchReminderTapIntents,
  type ReminderTapNative,
  type StartGate,
} from './reminderTap';
import { handleResponse, replayPendingHref, type ResponseDeps } from './responses';

export interface NotificationsHostProps {
  /** A drive is recording now: foreground notifications are not shown. Read per notification. */
  isRecording: () => boolean;
  /** A drive is under way (recording → finalizing): taps are held, not navigated. */
  isBusy: () => boolean;
  /** Called on every change of the busy signal's source; returns the unsubscribe. */
  subscribeBusy: (listener: () => void) => () => void;
  /** The Start Drive button's start: the only start a reminder tap may use. */
  startDrive: () => Promise<StartResult>;
  /** Whether a reminder tap may start a drive now (`reminderStartGate`). Read each render and per try. */
  startGate: () => StartGate;
  /** The root navigator is mounted and can take a push. Defaults to true. */
  ready?: boolean;
  /** Where a route is opened. Defaults to `router.push`. */
  navigate?: (href: string) => void;
  /** The reminder's native face (tests inject a fake). Defaults to the module. */
  reminderNative?: ReminderTapNative;
  onError?: (e: unknown, ctx: string) => void;
}

const defaultNavigate = (href: string) => router.push(href as Href);
/**
 * A reminder tap's route: onto the screen already showing it rather than a second copy of it. Home
 * pops back to the tabs under whatever is open (and selects Home); with nothing above them, popping
 * is not a tabs action, so it is a plain navigate (a tab switch).
 */
const defaultTapNavigate = (href: string) => {
  if (href === REMINDER_HOME_HREF && router.canDismiss()) router.dismissTo(href as Href);
  else router.navigate(href as Href);
};

const responseKey = (r: Notifications.NotificationResponse) =>
  `${r.notification.request.identifier}@${r.notification.date}#${r.actionIdentifier}`;

export function NotificationsHost(props: NotificationsHostProps): null {
  const { db, now } = useDataSource();
  const ready = props.ready ?? true;

  // Latest props, read by listeners that are attached once per mount.
  const latest = useRef({ props, ready, db, now });
  // Declared first, so every effect below reads this render's values.
  useLayoutEffect(() => {
    latest.current = { props, ready, db, now };
  });
  /** Something may be held in settings: true at mount (a tap from an earlier process), and after a deferral. */
  const mayHavePending = useRef(true);
  /** Replays the held tap if the app may navigate now; a no-op until the navigator is ready. */
  const replay = useRef<() => void>(() => {});
  /** Counts deferrals, so a replay that raced one runs again. */
  const deferrals = useRef(0);
  /** The reminder tap waiting to run (the newest replaces an older one), and whether one is running. */
  const heldTap = useRef<ReminderTap | null>(null);
  const tapping = useRef(false);

  /** Runs the held reminder tap once the gate allows; one run at a time. Reads only refs. */
  const tryTap = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    tryTap.current = () => {
      const hold = heldTap.current;
      if (hold === null || tapping.current) return;
      const l = latest.current;
      tapping.current = true;
      startFromReminderTap(hold, {
        start: () => latest.current.props.startDrive(),
        navigate: l.props.navigate ?? defaultTapNavigate,
        notice: showStartNotice,
        gate: () => latest.current.props.startGate(),
        now: latest.current.now,
        native: l.props.reminderNative,
        onError: l.props.onError,
      })
        .then((out) => {
          // A drive is under way: an older line about a reminder that started none is spent.
          if (out === 'started') clearStartNotice();
          if (out !== 'waiting' && heldTap.current === hold) heldTap.current = null;
        })
        .catch((e: unknown) => {
          if (heldTap.current === hold) heldTap.current = null;
          latest.current.props.onError?.(e, 'notifications.reminder');
        })
        .finally(() => {
          tapping.current = false;
          // A newer tap arrived while this one ran.
          if (heldTap.current !== null && heldTap.current !== hold) tryTap.current();
        });
    };
  }, []);

  useEffect(() => {
    const report = (e: unknown, ctx: string) => latest.current.props.onError?.(e, ctx);
    const deps = (): ResponseDeps => {
      const l = latest.current;
      return {
        db: l.db,
        now: l.now,
        navigate: l.props.navigate ?? defaultNavigate,
        isBusy: () => !latest.current.ready || latest.current.props.isBusy(),
        onError: report,
      };
    };

    ensureNotificationSetup().catch((e: unknown) => report(e, 'notifications.setup'));
    const uninstall = installForegroundHandler({
      isRecording: () => latest.current.props.isRecording(),
    });

    const hold = (tap: ReminderTap) => {
      heldTap.current = tap;
      tryTap.current();
    };

    const seen = new Set<string>();
    const take = (r: Notifications.NotificationResponse | null) => {
      if (!r) return;
      let key: string;
      try {
        key = responseKey(r);
      } catch {
        return;
      }
      if (seen.has(key)) return;
      seen.add(key);
      Notifications.clearLastNotificationResponse();
      // The reminder's own note: its token is held for a start, never opened as a link.
      if (isReminderResponse(r)) {
        const token = reminderTokenOf(r);
        if (token !== null) hold({ token, at: latest.current.now() });
        return;
      }
      handleResponse(r, deps())
        .then((out) => {
          if (out.kind !== 'deferred') return;
          mayHavePending.current = true;
          deferrals.current += 1;
          // What held it may already be over (the navigator mounted during the write).
          replay.current();
        })
        .catch((e: unknown) => report(e, 'notifications.response'));
    };

    const responses = Notifications.addNotificationResponseReceivedListener(take);
    take(Notifications.getLastNotificationResponse());
    // Android hands a reminder tap over natively (once per token).
    const unwatch = watchReminderTapIntents(hold, latest.current.props.reminderNative);

    return () => {
      responses.remove();
      unwatch();
      uninstall();
    };
  }, []);

  const { subscribeBusy } = props;
  useEffect(() => {
    if (!ready) return;
    let replaying = false;
    const tryReplay = () => {
      // A reminder tap waits on the same busy signal as a held link.
      tryTap.current();
      if (replaying || !mayHavePending.current) return;
      const l = latest.current;
      if (l.props.isBusy()) return;
      replaying = true;
      mayHavePending.current = false;
      const seq = deferrals.current;
      replayPendingHref({
        db: l.db,
        now: l.now,
        navigate: l.props.navigate ?? defaultNavigate,
        isBusy: () => !latest.current.ready || latest.current.props.isBusy(),
      })
        .then((out) => {
          if (out.kind === 'busy') mayHavePending.current = true;
        })
        .catch((e: unknown) => {
          // Tried again at the next change of the busy signal, not in a loop.
          mayHavePending.current = true;
          l.props.onError?.(e, 'notifications.replay');
        })
        .finally(() => {
          replaying = false;
          // A tap deferred while this replay ran.
          if (deferrals.current !== seq) tryReplay();
        });
    };
    replay.current = tryReplay;
    tryReplay();
    const unsubscribe = subscribeBusy(tryReplay);
    return () => {
      replay.current = () => {};
      unsubscribe();
    };
  }, [ready, subscribeBusy]);

  // A held reminder tap runs once the app can start a drive (signed in, set up, booted, idle).
  const gate = props.startGate();
  useEffect(() => {
    tryTap.current();
  }, [gate]);

  return null;
}

/**
 * The app's only notification response listener (rev1: C1: one plumbing for local and pushed
 * notifications).
 *
 * On mount: the Android channels (`ensureNotificationSetup`), the one
 * foreground handler, the response listener, the tap that launched the app (read once with the
 * SDK 57 `getLastNotificationResponse`, then cleared so a remount does not act on it again). A tap
 * is acted on by `handleResponse`; one
 * that lands during a drive, or before the navigator is mounted, is held and replayed when the
 * drive's busy signal says it is over. One that lands while the driving screen is the top route
 * (a drive just over, the screen about to leave for its recap or Home) is held the same way and
 * replayed once the driving screen has left, so no route is ever opened over the driving screen.
 *
 * A tap on the drive's recording note (`kind: 'driveRecording'`, the iPhone's note while a drive
 * records) opens the driving screen, through `router.navigate` so it never stacks a second one, and
 * only while the engine is recording (`isDriveRecording`; not while a drive only finalizes); one
 * that lands before the navigator is mounted waits for it. It is never held past the drive, never
 * replayed, and starts nothing.
 *
 * The recap's "I wasn't driving" (an automatic drive's): with no drive under way it waits for the
 * navigator (a cold launch from the action included), then asks its confirm when it is offered
 * (`passengerOffered`: the recap never opened, the drive ended 30 minutes ago at most) and marks the
 * drive on "Mark as passenger"; otherwise it opens the recap, as a tap on the notification does
 * (held like one during a drive).
 *
 * "Are you driving?" (`kind: 'passengerCheck'`, an automatic drive whose route never held the car):
 * handed at once to `onPassengerCheck` with its drive (the root layout stops that drive as the driving
 * screen's "Not driving?" does, when it is the one recording), never held for the drive; then Home,
 * once the navigator is up, unless the driving screen shows (it leaves for Home by itself when its
 * drive goes).
 *
 * Any other tap (or a held one's replay) opens its route, except a drive's summary already on
 * screen: the driving screen opened it as the drive ended, so its "Drive ended" note opens nothing more.
 * A drive recap held because a drive records (the recap of the drive before) opens the driving
 * screen meanwhile, as the recording note does, and its own route once the drive is over. Every
 * other held tap (a friend request, the weekly recap, the drive list), and any tap held while a
 * drive only finalizes, keeps the current screen and opens its route once the drive is over.
 *
 * Battery (§3.5): no timer and no polling. The busy subscription fires with the drive host's state
 * changes, and a change of route away from the driving screen asks once more; while nothing is held
 * either returns after one boolean read.
 *
 * Renders nothing. Mounted by the root layout inside `DataProvider` and the query client (Task 18),
 * which also removes M3's interim `useSummaryNotificationRouting`, so one tap navigates once.
 */
import * as Notifications from 'expo-notifications';
import { router, usePathname, type Href } from 'expo-router';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { useDataSource } from '@/data/queries';
import { markNotDriving } from '@/data/sync/driveActions';

import { ensureNotificationSetup } from './categories';
import { installForegroundHandler } from './handler';
import { DRIVE_HREF, drivingHrefOf, SUMMARY_HREF } from './hrefs';
import { confirmPassenger, passengerOffered, passengerTapOf } from './passenger';
import { passengerCheckOf } from './passengerCheck';
import { FALLBACK_HREF, handleResponse, replayPendingHref, type ResponseDeps } from './responses';

export interface NotificationsHostProps {
  /**
   * Foreground notifications are not shown (the root layout: a drive under way, finalizing
   * included). Read per notification.
   */
  isRecording: () => boolean;
  /**
   * The engine is recording a drive now (not finalizing): only then does a tap open the driving
   * screen (the recording note, a held drive recap).
   */
  isDriveRecording: () => boolean;
  /** A drive is under way (recording → finalizing): taps are held, not navigated. */
  isBusy: () => boolean;
  /** Called on every change of the busy signal's source; returns the unsubscribe. */
  subscribeBusy: (listener: () => void) => () => void;
  /** The root navigator is mounted and can take a push. Defaults to true. */
  ready?: boolean;
  /** Where a route is opened. Defaults to `router.push` (`router.navigate` for the driving screen). */
  navigate?: (href: string) => void;
  /** The passenger confirm; resolves true for "Mark as passenger". Defaults to the system alert. */
  confirmPassenger?: () => Promise<boolean>;
  /**
   * A tap on "Are you driving?" for this drive: the app stops it when it is the one recording (the
   * root layout injects it; this plumbing reaches nothing of the drive). Home opens after it settles.
   */
  onPassengerCheck?: (clientTripId: string) => Promise<void>;
  onError?: (e: unknown, ctx: string) => void;
}

const defaultNavigate = (href: string) => router.push(href as Href);
/** The driving screen: onto the one already showing rather than a second copy of it. */
const defaultDriveNavigate = (href: string) => router.navigate(href as Href);

const responseKey = (r: Notifications.NotificationResponse) =>
  `${r.notification.request.identifier}@${r.notification.date}#${r.actionIdentifier}`;

/** The note's `data`, read defensively: a malformed response has none. */
const dataOf = (r: Notifications.NotificationResponse): unknown => {
  try {
    return r.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER ? r.notification.request.content.data : null;
  } catch {
    return null;
  }
};

export function NotificationsHost(props: NotificationsHostProps): null {
  const { db, now } = useDataSource();
  const ready = props.ready ?? true;

  const pathname = usePathname();

  // Latest props, read by listeners that are attached once per mount.
  const latest = useRef({ props, ready, db, now, pathname });
  // Declared first, so every effect below reads this render's values.
  useLayoutEffect(() => {
    latest.current = { props, ready, db, now, pathname };
  });
  /**
   * A tap's route (and a held one's replay). A drive's summary already on screen is not opened a
   * second time: the driving screen opens it as the drive ends, and the "Drive ended" note for the
   * same drive lands there.
   */
  const tapRoute = useRef((href: string) => {
    const summary = SUMMARY_HREF.exec(href);
    if (summary !== null && latest.current.pathname === `/drives/${summary[1]}`) return;
    (latest.current.props.navigate ?? defaultNavigate)(href);
  });
  /**
   * A tap's route must wait: a drive is under way, or the driving screen is the top route (a route
   * opened over it would be the one its way out replaces). Reads only refs.
   */
  const mustHold = useRef(() => latest.current.props.isBusy() || latest.current.pathname === DRIVE_HREF);
  /** Something may be held in settings: true at mount (a tap from an earlier process), and after a deferral. */
  const mayHavePending = useRef(true);
  /** Replays the held tap if the app may navigate now; a no-op until the navigator is ready. */
  const replay = useRef<() => void>(() => {});
  /** Counts deferrals, so a replay that raced one runs again. */
  const deferrals = useRef(0);
  /** A tap for the driving screen (the recording note, or a recap held while a drive records) waiting for the navigator. */
  const driveTap = useRef(false);
  /** A recap's "I wasn't driving" waiting for the navigator: its drive and the response itself. */
  const passengerTap = useRef<{ clientTripId: string; response: Notifications.NotificationResponse } | null>(null);
  /** An "Are you driving?" tap whose Home waits for the navigator (its drive already handed on). */
  const checkTap = useRef(false);
  /** Hands a response to `handleResponse` (set by the listener effect). */
  const route = useRef<(r: Notifications.NotificationResponse) => void>(() => {});

  /**
   * A waiting "I wasn't driving", once the navigator is up: a drive under way makes it a recap tap
   * (held); else the confirm when offered, or the recap. Reads only refs.
   */
  const openPassenger = useRef(() => {
    const tap = passengerTap.current;
    if (tap === null || !latest.current.ready) return;
    passengerTap.current = null;
    const l = latest.current;
    if (l.props.isBusy()) {
      route.current(tap.response);
      return;
    }
    const report = (e: unknown) => l.props.onError?.(e, 'notifications.passenger');
    void (async () => {
      const offered = await passengerOffered(l.db, tap.clientTripId, l.now()).catch((e: unknown) => {
        report(e);
        return false;
      });
      if (!offered) {
        route.current(tap.response);
        return;
      }
      if (!(await (l.props.confirmPassenger ?? confirmPassenger)())) return;
      await markNotDriving(tap.clientTripId, { db: l.db, now: l.now }, { via: 'notification' });
    })().catch(report);
  });

  /** Opens the driving screen for a waiting tap, once the navigator is up. Reads only refs. */
  const openDrive = useRef(() => {
    if (!driveTap.current || !latest.current.ready) return;
    driveTap.current = false;
    const l = latest.current;
    // The drive already ended: its note has nothing left to open.
    if (!l.props.isDriveRecording() || l.pathname === DRIVE_HREF) return;
    (l.props.navigate ?? defaultDriveNavigate)(DRIVE_HREF);
  });

  /** Home for an "Are you driving?" tap, once the navigator is up; not over the driving screen (it leaves by itself). */
  const openCheckHome = useRef(() => {
    if (!checkTap.current || !latest.current.ready) return;
    checkTap.current = false;
    const l = latest.current;
    if (l.pathname === DRIVE_HREF || l.pathname === FALLBACK_HREF) return;
    tapRoute.current(FALLBACK_HREF);
  });

  useEffect(() => {
    const report = (e: unknown, ctx: string) => latest.current.props.onError?.(e, ctx);
    const deps = (): ResponseDeps => {
      const l = latest.current;
      return {
        db: l.db,
        now: l.now,
        navigate: tapRoute.current,
        isBusy: () => !latest.current.ready || mustHold.current(),
        onError: report,
      };
    };

    ensureNotificationSetup().catch((e: unknown) => report(e, 'notifications.setup'));
    const uninstall = installForegroundHandler({
      isRecording: () => latest.current.props.isRecording(),
    });

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
      // The drive's recording note: the driving screen, now or once the navigator is up; never held.
      if (drivingHrefOf(dataOf(r)) !== null) {
        driveTap.current = true;
        openDrive.current();
        return;
      }
      // "Are you driving?": its drive goes to the app now (never held for the drive), then Home.
      const checkTrip = passengerCheckOf(dataOf(r));
      if (checkTrip !== null) {
        const handler = latest.current.props.onPassengerCheck;
        void (handler ? handler(checkTrip) : Promise.resolve())
          .catch((e: unknown) => report(e, 'notifications.passengerCheck'))
          .finally(() => {
            checkTap.current = true;
            openCheckHome.current();
          });
        return;
      }
      // The recap's "I wasn't driving", with no drive under way: the confirm, once the navigator is up.
      const passengerTrip = passengerTapOf(r);
      if (passengerTrip !== null && !latest.current.props.isBusy()) {
        passengerTap.current = { clientTripId: passengerTrip, response: r };
        openPassenger.current();
        return;
      }
      route.current(r);
    };
    route.current = (r: Notifications.NotificationResponse) => {
      handleResponse(r, deps())
        .then((out) => {
          if (out.kind !== 'deferred') return;
          mayHavePending.current = true;
          deferrals.current += 1;
          // A drive recap held because a drive records: the driving screen meanwhile (the recap
          // opens after the drive), now or once the navigator is up. Any other held route keeps the
          // current screen until the drive is over.
          if (SUMMARY_HREF.test(out.href) && latest.current.props.isDriveRecording()) {
            driveTap.current = true;
            openDrive.current();
          }
          // What held it may already be over (the navigator mounted during the write).
          replay.current();
        })
        .catch((e: unknown) => report(e, 'notifications.response'));
    };

    const responses = Notifications.addNotificationResponseReceivedListener(take);
    take(Notifications.getLastNotificationResponse());

    return () => {
      responses.remove();
      uninstall();
    };
  }, []);

  const { subscribeBusy } = props;
  useEffect(() => {
    if (!ready) return;
    // A recording-note tap, a recap's "I wasn't driving" or an "Are you driving?", that came before the navigator.
    openDrive.current();
    openPassenger.current();
    openCheckHome.current();
    let replaying = false;
    const tryReplay = () => {
      if (replaying || !mayHavePending.current) return;
      const l = latest.current;
      if (mustHold.current()) return;
      replaying = true;
      mayHavePending.current = false;
      const seq = deferrals.current;
      replayPendingHref({
        db: l.db,
        now: l.now,
        navigate: tapRoute.current,
        isBusy: () => !latest.current.ready || mustHold.current(),
      })
        .then((out) => {
          if (out.kind === 'busy') mayHavePending.current = true;
        })
        .catch((e: unknown) => {
          // Tried again at the next change of the busy signal or of the route, not in a loop.
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

  // The driving screen has left: a tap held while it was the top route opens now.
  useEffect(() => {
    if (pathname !== DRIVE_HREF) replay.current();
  }, [pathname]);

  return null;
}

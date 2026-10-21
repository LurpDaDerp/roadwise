/**
 * The app's only notification response listener (rev1: C1: one plumbing for local and pushed
 * notifications).
 *
 * On mount: the Android channels (`ensureNotificationSetup`), the one
 * foreground handler, the response listener, the tap that launched the app (read once with the
 * SDK 57 `getLastNotificationResponse`, then cleared so a remount does not act on it again). A tap
 * is acted on by `handleResponse`; one
 * that lands during a drive, or before the navigator is mounted, is held and replayed when the
 * drive's busy signal says it is over.
 *
 * A tap on the drive's recording note (`kind: 'driveRecording'`, the iPhone's note while a drive
 * records) opens the driving screen, through `router.navigate` so it never stacks a second one, and
 * only while a drive records; one that lands before the navigator is mounted waits for it. It is
 * never held past the drive, never replayed, and starts nothing.
 *
 * Any other tap (or a held one's replay) opens its route, except a drive's summary already on
 * screen: the driving screen opened it as the drive ended, so its "Drive ended" note opens nothing more.
 *
 * Battery (§3.5): no timer and no polling. The busy subscription fires with the drive host's state
 * changes; while nothing is held it returns after one boolean read.
 *
 * Renders nothing. Mounted by the root layout inside `DataProvider` and the query client (Task 18),
 * which also removes M3's interim `useSummaryNotificationRouting`, so one tap navigates once.
 */
import * as Notifications from 'expo-notifications';
import { router, usePathname, type Href } from 'expo-router';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { useDataSource } from '@/data/queries';

import { ensureNotificationSetup } from './categories';
import { installForegroundHandler } from './handler';
import { DRIVE_HREF, drivingHrefOf, SUMMARY_HREF } from './hrefs';
import { handleResponse, replayPendingHref, type ResponseDeps } from './responses';

export interface NotificationsHostProps {
  /** A drive is recording now: foreground notifications are not shown. Read per notification. */
  isRecording: () => boolean;
  /** A drive is under way (recording → finalizing): taps are held, not navigated. */
  isBusy: () => boolean;
  /** Called on every change of the busy signal's source; returns the unsubscribe. */
  subscribeBusy: (listener: () => void) => () => void;
  /** The root navigator is mounted and can take a push. Defaults to true. */
  ready?: boolean;
  /** Where a route is opened. Defaults to `router.push` (`router.navigate` for the driving screen). */
  navigate?: (href: string) => void;
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
  /** Something may be held in settings: true at mount (a tap from an earlier process), and after a deferral. */
  const mayHavePending = useRef(true);
  /** Replays the held tap if the app may navigate now; a no-op until the navigator is ready. */
  const replay = useRef<() => void>(() => {});
  /** Counts deferrals, so a replay that raced one runs again. */
  const deferrals = useRef(0);
  /** A recording-note tap waiting for the navigator. */
  const driveTap = useRef(false);

  /** Opens the driving screen for a waiting recording-note tap, once the navigator is up. Reads only refs. */
  const openDrive = useRef(() => {
    if (!driveTap.current || !latest.current.ready) return;
    driveTap.current = false;
    const l = latest.current;
    // The drive already ended: its note has nothing left to open.
    if (!l.props.isRecording() || l.pathname === DRIVE_HREF) return;
    (l.props.navigate ?? defaultDriveNavigate)(DRIVE_HREF);
  });

  useEffect(() => {
    const report = (e: unknown, ctx: string) => latest.current.props.onError?.(e, ctx);
    const deps = (): ResponseDeps => {
      const l = latest.current;
      return {
        db: l.db,
        now: l.now,
        navigate: tapRoute.current,
        isBusy: () => !latest.current.ready || latest.current.props.isBusy(),
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

    return () => {
      responses.remove();
      uninstall();
    };
  }, []);

  const { subscribeBusy } = props;
  useEffect(() => {
    if (!ready) return;
    // A recording-note tap that came before the navigator.
    openDrive.current();
    let replaying = false;
    const tryReplay = () => {
      if (replaying || !mayHavePending.current) return;
      const l = latest.current;
      if (l.props.isBusy()) return;
      replaying = true;
      mayHavePending.current = false;
      const seq = deferrals.current;
      replayPendingHref({
        db: l.db,
        now: l.now,
        navigate: tapRoute.current,
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

  return null;
}

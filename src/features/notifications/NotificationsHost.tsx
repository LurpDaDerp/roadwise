/**
 * The app's only notification response listener and received listener (rev1: C1 — one plumbing
 * for local and pushed notifications).
 *
 * On mount: the channels and the "Were you driving?" category (`ensureNotificationSetup`), the one
 * foreground handler, the response listener, the tap that launched the app (read once with the
 * SDK 57 `getLastNotificationResponse`, then cleared so a remount does not act on it again), and
 * the received listener, which marks the inbox and the rewards data stale. A tap is acted on by `handleResponse`; one
 * that lands during a drive, or before the navigator is mounted, is held and replayed when the
 * drive's busy signal says it is over.
 *
 * Battery (§3.5): no timer and no polling. The busy subscription fires with the drive host's state
 * changes; while nothing is held it returns after one boolean read.
 *
 * Renders nothing. Mounted by the root layout inside `DataProvider` and the query client (Task 18),
 * which also removes M3's interim `useSummaryNotificationRouting`, so one tap navigates once.
 */
import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { router, type Href } from 'expo-router';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { invalidateTrip, useDataSource } from '@/data/queries';
import { INBOX_QUERY_KEY, REWARDS_QUERY_KEY } from '@/notifications/keys';

import { ensureNotificationSetup } from './categories';
import { installForegroundHandler } from './handler';
import { handleResponse, replayPendingHref, type ResponseDeps } from './responses';

export interface NotificationsHostProps {
  /** A drive is recording now: foreground notifications are not shown. Read per notification. */
  isRecording: () => boolean;
  /** A drive is under way (candidate → finalizing): taps are held, not navigated. */
  isBusy: () => boolean;
  /** Called on every change of the busy signal's source; returns the unsubscribe. */
  subscribeBusy: (listener: () => void) => () => void;
  /** The root navigator is mounted and can take a push. Defaults to true. */
  ready?: boolean;
  /** Where a route is opened. Defaults to `router.push`. */
  navigate?: (href: string) => void;
  onError?: (e: unknown, ctx: string) => void;
}

const defaultNavigate = (href: string) => router.push(href as Href);

const responseKey = (r: Notifications.NotificationResponse) =>
  `${r.notification.request.identifier}@${r.notification.date}#${r.actionIdentifier}`;

export function NotificationsHost(props: NotificationsHostProps): null {
  const { db, now } = useDataSource();
  const queryClient = useQueryClient();
  const ready = props.ready ?? true;

  // Latest props, read by listeners that are attached once per mount.
  const latest = useRef({ props, ready, db, now, queryClient });
  // Declared first, so every effect below reads this render's values.
  useLayoutEffect(() => {
    latest.current = { props, ready, db, now, queryClient };
  });
  /** Something may be held in settings: true at mount (a tap from an earlier process), and after a deferral. */
  const mayHavePending = useRef(true);
  /** Replays the held tap if the app may navigate now; a no-op until the navigator is ready. */
  const replay = useRef<() => void>(() => {});
  /** Counts deferrals, so a replay that raced one runs again. */
  const deferrals = useRef(0);

  useEffect(() => {
    const report = (e: unknown, ctx: string) => latest.current.props.onError?.(e, ctx);
    const deps = (): ResponseDeps => {
      const l = latest.current;
      return {
        db: l.db,
        now: l.now,
        navigate: l.props.navigate ?? defaultNavigate,
        isBusy: () => !latest.current.ready || latest.current.props.isBusy(),
        onTripChanged: (id) => invalidateTrip(l.queryClient, id),
        dismiss: (identifier) => Notifications.dismissNotificationAsync(identifier),
        // A tapped push's row was just marked read: the bell and the list refresh (T6 carry).
        onInboxChanged: () => l.queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY }),
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
    const received = Notifications.addNotificationReceivedListener(() => {
      const client = latest.current.queryClient;
      client.invalidateQueries({ queryKey: INBOX_QUERY_KEY }).catch((e: unknown) => report(e, 'notifications.inbox'));
      // A rewards notification announces a settled value: an open rewards screen refetches it.
      client.invalidateQueries({ queryKey: REWARDS_QUERY_KEY }).catch((e: unknown) => report(e, 'notifications.rewards'));
    });

    return () => {
      responses.remove();
      received.remove();
      uninstall();
    };
  }, []);

  const { subscribeBusy } = props;
  useEffect(() => {
    if (!ready) return;
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

  return null;
}

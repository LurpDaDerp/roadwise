/**
 * Mounted once by the root layout (H2). Two jobs:
 *
 * 1. Attach the drive-summary notifier to the drive host (idempotent per host — the Android
 *    headless runtime may attach the same host through `attachSummaryNotifier` directly).
 * 2. Route a tap on a drive-summary notification: one drive → its summary (D1), a batch → the
 *    trips list. A tap that launched the app waits for `ready` (the navigator mounted); a tap
 *    that lands during a drive waits until the drive is over, so the lockout never races it.
 *
 * The host is passed in, not read from `DriveProvider`: the root layout calls this hook above the
 * provider it renders. `null` while the runtime is still booting.
 */
import * as Notifications from 'expo-notifications';
import { router, type Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import type { DriveHost } from '@/drive/host';

import { attachSummaryNotifier, summaryHrefFor } from './summaryNotifier';

type HostLike = Pick<DriveHost, 'snapshot' | 'subscribe' | 'isBusy'>;

const responseKey = (r: Notifications.NotificationResponse) =>
  `${r.notification.request.identifier}@${r.notification.date}`;

export function useSummaryNotificationRouting(opts: {
  host: HostLike | null | undefined;
  /** The navigator can take a push (the root Stack is mounted). Defaults to true. */
  ready?: boolean;
}): void {
  const { host, ready = true } = opts;
  const [pending, setPending] = useState<Href | null>(null);
  const handled = useRef(new Set<string>());

  // 1. The notifier.
  useEffect(() => {
    if (!host) return;
    const notifier = attachSummaryNotifier(host);
    return () => notifier.detach();
  }, [host]);

  // 2a. Taps: the one that launched the app, then every later one.
  useEffect(() => {
    const take = (r: Notifications.NotificationResponse | null) => {
      if (!r || r.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const href = summaryHrefFor(r);
      if (!href) return;
      const key = responseKey(r);
      if (handled.current.has(key)) return;
      handled.current.add(key);
      Notifications.clearLastNotificationResponse();
      setPending(href);
    };
    take(Notifications.getLastNotificationResponse());
    const sub = Notifications.addNotificationResponseReceivedListener(take);
    return () => sub.remove();
  }, []);

  // 2b. Deliver the pending route once the navigator is up and no drive is under way.
  useEffect(() => {
    if (!pending || !ready) return;
    const go = () => {
      router.push(pending);
      setPending(null);
    };
    if (!host || !host.isBusy()) {
      go();
      return;
    }
    const unsubscribe = host.subscribe(() => {
      if (!host.isBusy()) {
        unsubscribe();
        go();
      }
    });
    return unsubscribe;
  }, [pending, ready, host]);
}

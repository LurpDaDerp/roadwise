// The navigation button's flow (product spec v3 "Driving screen · Navigation"; design §7.4).
//
// - First tap (nothing saved): the list "Select default navigation app" of the apps installed.
//   Choosing one saves it and opens it.
// - Later taps: the saved app opens directly. Gone (uninstalled): the saved choice is cleared and the
//   list shows again, saying so. It did not open: the list shows, saying so.
// - A long press (or the screen reader's "Change navigation app") once an app is saved: the same
//   list, the saved app marked. Choosing one saves it as the new default and opens it. With nothing
//   saved, a long press is a first tap: the list.
// - Every open tells the drive host first (`noteLeaving`): leaving RoadWise this way is the one
//   screen switch that is never phone use. An open that fails takes it back (`cancelLeaving`).
// - A tap while an open is in flight is ignored (at most 3 s). It works at any speed.
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Db } from '@/data/db';
import { cancelLeaving, noteLeaving } from '@/drive/leave';

import { defaultNavAppsPort, findInstalledNavApp, listInstalledNavApps, openNavApp, type InstalledNavApp, type NavAppsPort } from './apps';
import { navAppById, type NavAppId } from './catalog';
import { clearNavApp, readNavApp, writeNavApp } from './prefs';

/** An open that has not settled by then is taken as done (the host's 10-s window still guards it). */
export const NAV_OPEN_TIMEOUT_MS = 3_000;

export type NavPicker = { mode: 'first' | 'gone' | 'failed' | 'change'; apps: InstalledNavApp[]; missingLabel?: string } | null;

export interface NavigationButton {
  /** The saved app, for the caption and the highlight; null when none. */
  saved: NavAppId | null;
  picker: NavPicker;
  press(): Promise<void>;
  /** The long press: the list again to pick a new default (a plain press when none is saved). */
  change(): Promise<void>;
  choose(app: InstalledNavApp): Promise<void>;
  close(): void;
}

const settle = (p: Promise<boolean>, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), ms);
    void p.then((ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
  });

export function useNavigationButton(db: Db | null, port: NavAppsPort = defaultNavAppsPort): NavigationButton {
  const [saved, setSaved] = useState<NavAppId | null>(null);
  const [picker, setPicker] = useState<NavPicker>(null);
  const busy = useRef(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    if (db !== null) void readNavApp(db).then((id) => live.current && setSaved(id));
    return () => {
      live.current = false;
    };
  }, [db]);

  const show = useCallback((next: NavPicker) => {
    if (live.current) setPicker(next);
  }, []);

  /** Note the leave, open, and take it back when the app did not open. */
  const leaveTo = useCallback(
    async (app: InstalledNavApp): Promise<boolean> => {
      noteLeaving();
      const ok = await settle(openNavApp(app, port), NAV_OPEN_TIMEOUT_MS);
      if (!ok) cancelLeaving();
      return ok;
    },
    [port]
  );

  const press = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const id = db === null ? null : await readNavApp(db);
      if (id !== null) {
        const app = await findInstalledNavApp(id, port);
        if (app !== null) {
          if (await leaveTo(app)) return;
          show({ mode: 'failed', apps: await listInstalledNavApps(port), missingLabel: app.label });
          return;
        }
        const apps = await listInstalledNavApps(port);
        if (db !== null) await clearNavApp(db).catch(() => {});
        if (live.current) setSaved(null);
        show({ mode: 'gone', apps, missingLabel: navAppById(id)?.label });
        return;
      }
      show({ mode: 'first', apps: await listInstalledNavApps(port) });
    } finally {
      busy.current = false;
    }
  }, [db, port, leaveTo, show]);

  const change = useCallback(async () => {
    if (busy.current) return;
    const id = db === null ? null : await readNavApp(db).catch(() => null);
    if (id === null) return press();
    if (busy.current) return;
    busy.current = true;
    try {
      show({ mode: 'change', apps: await listInstalledNavApps(port) });
    } finally {
      busy.current = false;
    }
  }, [db, port, press, show]);

  const choose = useCallback(
    async (app: InstalledNavApp) => {
      if (busy.current) return;
      busy.current = true;
      try {
        // A failed write leaves the drive alone: the app still opens, and the list comes next time.
        if (db !== null) await writeNavApp(db, app.id).catch(() => {});
        if (live.current) setSaved(app.id);
        if (await leaveTo(app)) {
          show(null);
          return;
        }
        show({ mode: 'failed', apps: picker?.apps ?? [app], missingLabel: app.label });
      } finally {
        busy.current = false;
      }
    },
    [db, leaveTo, picker, show]
  );

  const close = useCallback(() => show(null), [show]);

  return { saved, picker, press, change, choose, close };
}

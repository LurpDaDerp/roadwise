// The navigation button's flow (product spec v3 "Driving screen · Navigation"; design §7.4).
//
// - First tap (nothing saved): the list "Choose your navigation app" of the apps installed.
//   Choosing one saves it and opens it.
// - Later taps: the saved app opens directly. Gone (uninstalled): the saved choice is cleared and the
//   list shows again, saying so. It did not open: the list shows, saying so.
// - Saved places: when the saved app is installed and takes a destination (`destinations.ts`) and at
//   least one place is saved, a tap shows "Where to?" instead: a row per place (Home, Work, School,
//   then the driver's own), each opening the app with driving directions to it, and last "Open
//   {app}", which opens the app as a plain tap would (a route in progress kept). The places are read
//   fresh each time. A place or the app that does not open: the apps list, saying so.
// - A long press (or the screen reader's "Change navigation app") once an app is saved: the same
//   list, the saved app marked (no places in it). Choosing one saves it as the new default and opens
//   it. With nothing saved, a long press is a first tap: the list.
// - A tap while an open is in flight is ignored (at most 3 s).
// - `locked` (the driving screen greys the button out at 35 mph and over): the list closes, and
//   nothing new starts or opens the list until it is free again. An app already opening finishes.
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Db } from '@/data/db';
import { createSettingsRepo } from '@/data/db/settings';
import { readPlaces, type SavedPlace } from '@/features/places/model';

import { defaultNavAppsPort, findInstalledNavApp, listInstalledNavApps, openDirections, openNavApp, type InstalledNavApp, type NavAppsPort } from './apps';
import { navAppById, type NavAppId } from './catalog';
import { drivingUrl, takesDestination } from './destinations';
import { clearNavApp, readNavApp, writeNavApp } from './prefs';

/** An open that has not settled by then is taken as done. */
export const NAV_OPEN_TIMEOUT_MS = 3_000;

/** The list of apps: to pick one, or after the saved one was gone or didn't open. */
export type NavAppsList = { mode: 'first' | 'gone' | 'failed' | 'change'; apps: InstalledNavApp[]; missingLabel?: string };
/** "Where to?": the saved places, then the saved app itself (installed, and it takes a destination). */
export type NavPlacesList = { mode: 'places'; app: InstalledNavApp; places: SavedPlace[] };
export type NavPicker = NavAppsList | NavPlacesList | null;

export interface NavigationButton {
  /** The saved app, for the caption and the highlight; null when none. */
  saved: NavAppId | null;
  /**
   * Whether a tap will likely show "Where to?" (the saved app takes a destination and places it can
   * reach are saved), for the button's screen-reader label. Read with the saved app and after every
   * tap; the tap itself always reads the places fresh.
   */
  hasPlaces: boolean;
  picker: NavPicker;
  press(): Promise<void>;
  /** The long press: the list again to pick a new default (a plain press when none is saved). */
  change(): Promise<void>;
  choose(app: InstalledNavApp): Promise<void>;
  /** "Where to?": driving directions to the place in the list's app. */
  goTo(place: SavedPlace): Promise<void>;
  /** "Where to?"'s last row: the list's app, opened as a plain tap opens it. */
  openApp(): Promise<void>;
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

export function useNavigationButton(db: Db | null, port: NavAppsPort = defaultNavAppsPort, locked = false): NavigationButton {
  const [saved, setSaved] = useState<NavAppId | null>(null);
  const [picker, setPicker] = useState<NavPicker>(null);
  const [hasPlaces, setHasPlaces] = useState(false);
  const busy = useRef(false);
  const live = useRef(true);
  const lockedNow = useRef(locked);

  useEffect(() => {
    live.current = true;
    if (db !== null) void readNavApp(db).then((id) => live.current && setSaved(id));
    return () => {
      live.current = false;
    };
  }, [db]);

  // Locked: no list shows, not even one a press already under way asks for.
  const show = useCallback((next: NavPicker) => {
    if (live.current && (next === null || !lockedNow.current)) setPicker(next);
  }, []);

  useEffect(() => {
    lockedNow.current = locked;
    if (locked && live.current) setPicker(null);
  }, [locked]);

  /** Open the app; false when it did not open. */
  const leaveTo = useCallback((app: InstalledNavApp): Promise<boolean> => settle(openNavApp(app, port), NAV_OPEN_TIMEOUT_MS), [port]);

  /** The saved places the app can take directions to, read fresh; none on a failed read. */
  const placesFor = useCallback(
    async (id: NavAppId | null): Promise<SavedPlace[]> => {
      if (db === null || id === null || !takesDestination(id, port.platform)) return [];
      const places = await readPlaces(createSettingsRepo(db)).catch((): SavedPlace[] => []);
      return places.filter((p) => drivingUrl(id, port.platform, p) !== null);
    },
    [db, port]
  );

  // The label's guess: whenever the saved app is known (or changes).
  useEffect(() => {
    void placesFor(saved).then((places) => live.current && setHasPlaces(places.length > 0));
  }, [saved, placesFor]);

  const press = useCallback(async () => {
    if (busy.current || lockedNow.current) return;
    busy.current = true;
    try {
      const id = db === null ? null : await readNavApp(db);
      if (id !== null) {
        const app = await findInstalledNavApp(id, port);
        if (app !== null) {
          const places = await placesFor(app.id);
          if (live.current) setHasPlaces(places.length > 0);
          if (places.length > 0) {
            show({ mode: 'places', app, places });
            return;
          }
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
  }, [db, port, leaveTo, placesFor, show]);

  const change = useCallback(async () => {
    if (busy.current || lockedNow.current) return;
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
      if (busy.current || lockedNow.current) return;
      busy.current = true;
      try {
        // A failed write leaves the drive alone: the app still opens, and the list comes next time.
        if (db !== null) await writeNavApp(db, app.id).catch(() => {});
        if (live.current) setSaved(app.id);
        if (await leaveTo(app)) {
          show(null);
          return;
        }
        show({ mode: 'failed', apps: picker !== null && picker.mode !== 'places' ? picker.apps : [app], missingLabel: app.label });
      } finally {
        busy.current = false;
      }
    },
    [db, leaveTo, picker, show]
  );

  /** From "Where to?": open `opening` (the list's app, or its directions); the apps list, saying so, when it does not open. */
  const leaveFromPlaces = useCallback(
    async (opening: (list: NavPlacesList) => Promise<boolean> | null) => {
      if (busy.current || lockedNow.current || picker === null || picker.mode !== 'places') return;
      const list = picker;
      const open = opening(list);
      if (open === null) return;
      busy.current = true;
      try {
        if (await settle(open, NAV_OPEN_TIMEOUT_MS)) {
          show(null);
          return;
        }
        show({ mode: 'failed', apps: await listInstalledNavApps(port), missingLabel: list.app.label });
      } finally {
        busy.current = false;
      }
    },
    [picker, port, show]
  );

  const goTo = useCallback(
    (place: SavedPlace) =>
      leaveFromPlaces((list) => {
        const url = drivingUrl(list.app.id, port.platform, place);
        return url === null ? null : openDirections(url, port);
      }),
    [leaveFromPlaces, port]
  );

  const openApp = useCallback(() => leaveFromPlaces((list) => openNavApp(list.app, port)), [leaveFromPlaces, port]);

  const close = useCallback(() => show(null), [show]);

  return { saved, hasPlaces, picker, press, change, choose, goTo, openApp, close };
}

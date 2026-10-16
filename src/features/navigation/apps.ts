// Finding and opening the driver's navigation apps (product spec v3 "Driving screen · Navigation").
//
// - iPhone: `canOpenURL('<scheme>://')` for each catalogue scheme (declared in
//   `LSApplicationQueriesSchemes`, without which iOS always answers false), opened with
//   `openURL('<scheme>://')` and no path, so a route in progress is shown, not replaced.
// - Android: drive-sense `listInstalledApps` / `launchApp` (a launcher-style intent: a route in
//   progress is resumed). The label is the installed app's own.
// Every failure reads as "not installed" or "did not open"; nothing here throws.
import { Linking, Platform } from 'react-native';

import DriveSense, { type InstalledApp } from '@drive-sense';

import { NAV_ANDROID_PACKAGES, NAV_APPS, navAppById, type NavAppId } from './catalog';

export interface InstalledNavApp {
  id: NavAppId;
  label: string;
  /** iOS: the URL opened; Android: the package launched. */
  target: string;
}

export interface NavAppsPort {
  platform: 'ios' | 'android';
  canOpenURL(url: string): Promise<boolean>;
  openURL(url: string): Promise<unknown>;
  listInstalledApps(packages: readonly string[]): Promise<InstalledApp[]>;
  launchApp(packageName: string): Promise<boolean>;
}

export const defaultNavAppsPort: NavAppsPort = {
  platform: Platform.OS === 'ios' ? 'ios' : 'android',
  canOpenURL: (url) => Linking.canOpenURL(url),
  openURL: (url) => Linking.openURL(url),
  listInstalledApps: (packages) => DriveSense.listInstalledApps(packages),
  launchApp: (packageName) => DriveSense.launchApp(packageName),
};

const schemeUrl = (scheme: string): string => `${scheme}://`;

/** The catalogue's apps installed on this phone, in catalogue order. */
export async function listInstalledNavApps(port: NavAppsPort = defaultNavAppsPort): Promise<InstalledNavApp[]> {
  if (port.platform === 'ios') {
    const found = await Promise.all(
      NAV_APPS.map(async (a): Promise<InstalledNavApp | null> => {
        if (a.iosScheme === null) return null;
        const url = schemeUrl(a.iosScheme);
        try {
          return (await port.canOpenURL(url)) ? { id: a.id, label: a.label, target: url } : null;
        } catch {
          return null;
        }
      })
    );
    return found.filter((a): a is InstalledNavApp => a !== null);
  }
  let installed: InstalledApp[];
  try {
    installed = await port.listInstalledApps(NAV_ANDROID_PACKAGES);
  } catch {
    return [];
  }
  const byPackage = new Map(installed.map((a) => [a.package, a.label] as const));
  const out: InstalledNavApp[] = [];
  for (const a of NAV_APPS) {
    const pkg = a.androidPackages.find((p) => byPackage.has(p));
    if (pkg === undefined) continue;
    const label = byPackage.get(pkg)?.trim();
    out.push({ id: a.id, label: label ? label : a.label, target: pkg });
  }
  return out;
}

/** The app with `id` if it is installed now, else null. */
export async function findInstalledNavApp(id: NavAppId, port: NavAppsPort = defaultNavAppsPort): Promise<InstalledNavApp | null> {
  if (navAppById(id) === null) return null;
  return (await listInstalledNavApps(port)).find((a) => a.id === id) ?? null;
}

/** Opens the app; true when the phone says it opened. */
export async function openNavApp(app: InstalledNavApp, port: NavAppsPort = defaultNavAppsPort): Promise<boolean> {
  try {
    if (port.platform === 'ios') {
      await port.openURL(app.target);
      return true;
    }
    return await port.launchApp(app.target);
  } catch {
    return false;
  }
}

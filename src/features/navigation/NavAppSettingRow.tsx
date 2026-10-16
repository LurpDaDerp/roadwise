// Settings › Driving › Navigation app: the saved default ("Not set", or "{App} · not on this phone"
// when it was uninstalled). Tapping shows the same list as the driving screen's button; choosing
// only saves: nothing opens and no drive is touched.
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import type { Db } from '@/data/db';
import { LinkRow } from '@/features/settings/parts';
import { Sheet, useTheme } from '@/ui';

import { defaultNavAppsPort, listInstalledNavApps, type InstalledNavApp, type NavAppsPort } from './apps';
import { navAppById, type NavAppId } from './catalog';
import { navCopy } from './copy';
import { NavAppPicker } from './NavAppPicker';
import { readNavApp, writeNavApp } from './prefs';

/** The row's subtitle: the saved app, not set, or saved but gone. */
export function navAppSubtitle(saved: NavAppId | null, installed: readonly InstalledNavApp[] | null): string {
  if (saved === null) return navCopy.settings.notSet;
  const label = navAppById(saved)?.label ?? navCopy.settings.notSet;
  if (installed !== null && !installed.some((a) => a.id === saved)) return navCopy.settings.gone(label);
  return label;
}

export function NavAppSettingRow({ db, port = defaultNavAppsPort }: { db: Db; port?: NavAppsPort }) {
  const t = useTheme();
  const [saved, setSaved] = useState<NavAppId | null>(null);
  const [installed, setInstalled] = useState<InstalledNavApp[] | null>(null);
  const [open, setOpen] = useState(false);

  // Read on every focus: an app installed or removed while away shows on the way back.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      void Promise.all([readNavApp(db), listInstalledNavApps(port)]).then(([id, apps]) => {
        if (!live) return;
        setSaved(id);
        setInstalled(apps);
      });
      return () => {
        live = false;
      };
    }, [db, port])
  );

  const onPress = async () => {
    const apps = await listInstalledNavApps(port);
    setInstalled(apps);
    setOpen(true);
  };

  const choose = async (app: InstalledNavApp) => {
    setOpen(false);
    setSaved(app.id);
    await writeNavApp(db, app.id).catch(() => {});
  };

  return (
    <>
      <LinkRow icon="navigate-outline" title={navCopy.settings.title} subtitle={navAppSubtitle(saved, installed)} onPress={() => void onPress()} testID="settings-nav-app" />
      <Sheet visible={open} onClose={() => setOpen(false)} testID="settings-nav-app-sheet">
        <NavAppPicker
          apps={installed ?? []}
          mode="settings"
          driveLine={false}
          selected={saved}
          colors={{ surface: t.colors.surface, ink: t.colors.text, muted: t.colors.textMuted, edge: t.colors.border }}
          onChoose={(app) => void choose(app)}
          onClose={() => setOpen(false)}
        />
      </Sheet>
    </>
  );
}

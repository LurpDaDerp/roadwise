// Settings › Driving › Navigation app (design §7.6): its subtitle states, and choosing only saves.
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { migrate, type Db } from '@/data/db';
import { setLeaveSink } from '@/drive/leave';
import type { NavAppsPort } from '@/features/navigation/apps';
import { NavAppSettingRow, navAppSubtitle } from '@/features/navigation/NavAppSettingRow';
import { readNavApp, writeNavApp } from '@/features/navigation/prefs';
import { ThemeProvider } from '@/ui/theme';

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return { useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]) };
});

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

const opened: string[] = [];
const port: NavAppsPort = {
  platform: 'ios',
  canOpenURL: async (url) => url === 'waze://' || url === 'maps://',
  openURL: async (url) => {
    opened.push(url);
  },
  listInstalledApps: async () => [],
  launchApp: async () => true,
};

async function mount() {
  await render(
    <ThemeProvider>
      <NavAppSettingRow db={db} port={port} />
    </ThemeProvider>
  );
  await act(async () => {});
}

test('the subtitle: not set, the saved app, or saved but not on this phone', () => {
  const waze = { id: 'waze' as const, label: 'Waze', target: 'waze://' };
  expect(navAppSubtitle(null, [waze])).toBe('Not set');
  expect(navAppSubtitle('waze', [waze])).toBe('Waze');
  expect(navAppSubtitle('waze', null)).toBe('Waze');
  expect(navAppSubtitle('google_maps', [waze])).toBe('Google Maps · not on this phone');
});

test('the row reads the saved app; a gone one says so', async () => {
  await writeNavApp(db, 'google_maps');
  await mount();
  expect(screen.getByText('Navigation app')).toBeOnTheScreen();
  expect(screen.getByText('Google Maps · not on this phone')).toBeOnTheScreen();
});

test('tapping it shows the list without the driving line; choosing only saves: nothing opens, no drive is touched', async () => {
  const leave = jest.fn();
  setLeaveSink({ beginLeave: leave, cancelLeave: leave, recording: () => true });
  await mount();
  expect(screen.getByText('Not set')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('settings-nav-app'));
  await act(async () => {});
  expect(screen.getByText('Select default navigation app')).toBeOnTheScreen();
  expect(screen.queryByText(/never costs points/)).toBeNull();
  expect(screen.getByText('You can change it in Settings › Driving.')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('nav-picker-row-waze'));
  await act(async () => {});
  expect(await readNavApp(db)).toBe('waze');
  expect(opened).toEqual([]);
  expect(leave).not.toHaveBeenCalled();
  expect(screen.getByText('Waze')).toBeOnTheScreen();
  setLeaveSink(null);
});

test('the saved app carries the checkmark in the list', async () => {
  await writeNavApp(db, 'waze');
  await mount();
  await fireEvent.press(screen.getByTestId('settings-nav-app'));
  await act(async () => {});
  expect(screen.getByTestId('nav-picker-row-waze').props.accessibilityState).toMatchObject({ selected: true });
  expect(screen.getByTestId('nav-picker-row-apple_maps').props.accessibilityState).toMatchObject({ selected: false });
});

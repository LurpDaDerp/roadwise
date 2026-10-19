// RoadWise opens nothing outside itself during a drive except the navigation app (design §6.6):
// the Settings pages, the Android browser, the store, the share sheets and the data export say
// "End the drive first" while a drive records, and open as usual outside one.
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';

import { createPermissionsAdapter } from '@/core/permissions/adapters';
import { blockedDuringDrive, cancelLeaving, driveRecording, leaveCopy, noteLeaving, setLeaveSink, type LeaveSink } from '@/drive/leave';
import { LegalLinks } from '@/features/auth/LegalLinks';
import { UpdateRequiredScreen } from '@/features/auth/UpdateRequiredScreen';
import { useExport } from '@/features/settings/exportFlow';
import { ThemeProvider } from '@/ui/theme';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node typings
const { readFileSync } = require('node:fs') as { readFileSync: (file: string, encoding: 'utf8') => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const { join } = require('node:path') as { join: (...parts: string[]) => string };

function sinkOf(recording: boolean): LeaveSink & { begin: jest.Mock; cancel: jest.Mock; set(v: boolean): void } {
  let on = recording;
  const begin = jest.fn();
  const cancel = jest.fn();
  return { begin, cancel, beginLeave: begin, cancelLeave: cancel, recording: () => on, set: (v) => (on = v) };
}

let alert: jest.SpyInstance;
let openSettings: jest.SpyInstance;
let sendIntent: jest.SpyInstance;
beforeEach(() => {
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  sendIntent = jest.spyOn(Linking, 'sendIntent').mockResolvedValue(undefined);
  // React Native's jest setup already mocks Linking: spyOn reuses those mocks, so clear their calls.
  for (const m of [alert, openSettings, sendIntent]) m.mockClear();
});
afterEach(() => {
  setLeaveSink(null);
  jest.restoreAllMocks();
});

describe('the sink', () => {
  test('with no host nothing is noted and nothing is blocked', () => {
    expect(driveRecording()).toBe(false);
    expect(blockedDuringDrive()).toBe(false);
    expect(() => noteLeaving()).not.toThrow();
    expect(() => cancelLeaving()).not.toThrow();
    expect(alert).not.toHaveBeenCalled();
  });

  test('the navigation button reaches the host; a host that throws never breaks the caller', () => {
    const s = sinkOf(true);
    setLeaveSink(s);
    noteLeaving();
    cancelLeaving();
    expect(s.begin).toHaveBeenCalledTimes(1);
    expect(s.cancel).toHaveBeenCalledTimes(1);
    setLeaveSink({ beginLeave: () => { throw new Error('x'); }, cancelLeave: () => { throw new Error('x'); }, recording: () => { throw new Error('x'); } });
    expect(() => noteLeaving()).not.toThrow();
    expect(() => cancelLeaving()).not.toThrow();
    expect(driveRecording()).toBe(false);
  });

  test('during a drive the guard shows one dialog, "End the drive first", and blocks', () => {
    setLeaveSink(sinkOf(true));
    expect(blockedDuringDrive()).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith('End the drive first', 'This opens outside RoadWise, and leaving RoadWise during a drive counts as phone use.', [{ text: 'OK' }]);
    expect(leaveCopy.title).toBe('End the drive first');
  });
});

describe('Settings pages', () => {
  test('during a drive Open Settings opens nothing and says why once; after End it opens; the adapter never notes a leave', async () => {
    const s = sinkOf(true);
    setLeaveSink(s);
    const adapter = createPermissionsAdapter({ platform: 'ios' });
    await expect(adapter.openAppSettings()).resolves.toBeUndefined();
    expect(openSettings).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    s.set(false);
    await adapter.openAppSettings();
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(s.begin).not.toHaveBeenCalled();
  });

  test('the Android battery page: no intent and no fallback page during a drive, one dialog', async () => {
    const s = sinkOf(true);
    setLeaveSink(s);
    await createPermissionsAdapter({ platform: 'android' }).openBatterySettings();
    expect(sendIntent).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    s.set(false);
    await createPermissionsAdapter({ platform: 'android' }).openBatterySettings();
    expect(sendIntent).toHaveBeenCalledTimes(1);
  });

  test("the Android Location page and the reminder channel's page: nothing opens during a drive, one dialog each", async () => {
    const s = sinkOf(true);
    setLeaveSink(s);
    const adapter = createPermissionsAdapter({ platform: 'android', androidPackage: () => 'app.roadwise' });
    await adapter.openLocationServicesSettings();
    await adapter.openNotificationChannelSettings('trip_reminder');
    expect(sendIntent).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(2);
    s.set(false);
    await adapter.openLocationServicesSettings();
    await adapter.openNotificationChannelSettings('trip_reminder');
    expect(sendIntent).toHaveBeenCalledTimes(2);
    expect(s.begin).not.toHaveBeenCalled();
  });

  test('the friend-code scanner sends the driver to Settings through the adapter (so the guard applies)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'features', 'friends', 'ScanScreen.tsx'), 'utf8');
    expect(src).toMatch(/defaultPermissionsAdapter\(\)\.openAppSettings\(\)/);
    expect(src).not.toMatch(/Linking/);
  });
});

describe('share sheets and the data export', () => {
  test('the export makes no request and opens no sheet or folder picker during a drive, one dialog; after End it runs', async () => {
    const s = sinkOf(true);
    setLeaveSink(s);
    const exportData = jest.fn(async () => ({ ok: true as const, json: '{}' }));
    const share = jest.fn(async (_json: string) => 'saved' as const);
    const { result } = await renderHook(() => useExport({ exportData, share }));
    await act(() => result.current.run());
    expect(exportData).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('idle');
    s.set(false);
    await act(() => result.current.run());
    expect(share).toHaveBeenCalledWith('{}');
    expect(result.current.state).toBe('saved');
    expect(s.begin).not.toHaveBeenCalled();
  });

  test.each([
    ['friend link', join('friends', 'AddFriendsScreen.tsx'), /if \(blockedDuringDrive\(\)\) return;\s*void Share\.share\(/],
    ['drive card', join('drives', 'ShareCard.tsx'), /if \(blockedDuringDrive\(\)\) return;\s*setState\('busy'\);[\s\S]*?Sharing\.shareAsync\(/],
  ])('the %s share asks the guard before the sheet opens', (_name, file, guard) => {
    const src = readFileSync(join(__dirname, '..', '..', 'features', file), 'utf8');
    expect(src).toMatch(guard);
    expect(src.match(/Share\.share\(|Sharing\.shareAsync\(/g)).toHaveLength(1);
  });
});

describe('the legal links and the store', () => {
  const TOS = { version: '2026-09-21', url: 'https://roadwise.app/terms' };
  const mountLegal = async (os: string) => {
    const open = jest.fn(async (_url: string) => {});
    await render(
      <ThemeProvider>
        <LegalLinks legal={{ published: true, tos: TOS, privacy: null }} open={open} os={os} />
      </ThemeProvider>
    );
    await fireEvent.press(screen.getByRole('link', { name: 'Terms' }));
    return open;
  };

  test('on iPhone the in-app browser opens over RoadWise during a drive', async () => {
    setLeaveSink(sinkOf(true));
    expect(await mountLegal('ios')).toHaveBeenCalledWith(TOS.url);
    expect(alert).not.toHaveBeenCalled();
  });

  test('on Android it would open outside RoadWise: blocked during a drive, open outside one', async () => {
    const s = sinkOf(true);
    setLeaveSink(s);
    expect(await mountLegal('android')).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    s.set(false);
    expect(await mountLegal('android')).toHaveBeenCalledWith(TOS.url);
  });

  test('the store link is blocked during a drive', async () => {
    setLeaveSink(sinkOf(true));
    const open = jest.fn(async (_url: string) => {});
    await render(
      <ThemeProvider>
        <UpdateRequiredScreen storeUrl="market://details?id=app.roadwise" open={open} />
      </ThemeProvider>
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Get the update' }));
    expect(open).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
  });
});

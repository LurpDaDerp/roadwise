/**
 * The optional "Forgot to start?" step: "Not now" asks nothing and moves on; "Turn on" asks for
 * what the reminder needs (iOS: Always, once), turns it on, says how it stands, then Continue.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { createFakeDriveSense } from '@drive-sense';

import { fakeAdapter, snap } from '@/features/permissions/__fixtures__/harness';
import { reminderCopy } from '@/features/reminder';
import { ThemeProvider } from '@/ui/theme';

import type { FlowContext } from '../flow';
import { ReminderStep } from '../steps/ReminderStep';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

const copy = reminderCopy.step;
const ctx = (platform: 'ios' | 'android'): FlowContext => ({ platform, hasUsername: true });

async function setup(platform: 'ios' | 'android', adapter = fakeAdapter(snap({ platform }))) {
  const native = createFakeDriveSense({ platform });
  const onNext = jest.fn();
  await render(
    <ThemeProvider>
      <ReminderStep ctx={ctx(platform)} onNext={onNext} deps={{ adapter, native }} />
    </ThemeProvider>
  );
  return { native, adapter, onNext };
}

const press = (testID: string) =>
  act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });

test('Not now asks nothing and leaves the reminder off', async () => {
  const { native, adapter, onNext } = await setup('ios');
  expect(screen.getByText(copy.title)).toBeOnTheScreen();
  await press('reminder-not-now');
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(adapter.log).toEqual([]);
  expect(native.calls).toEqual([]);
  expect(native.tripReminderOn).toBe(false);
});

test('iPhone: Turn on asks for Always (While Using already granted), says how it stands, then Continue', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'foreground' }));
  const { native, onNext } = await setup('ios', adapter);
  expect(screen.getByText(`• ${copy.ios}`)).toBeOnTheScreen();
  await press('reminder-turn-on');
  expect(adapter.log).toEqual(['snapshot', 'requestAlwaysForReminder']);
  expect(native.tripReminderOn).toBe(true);
  expect(screen.getByText(reminderCopy.lines.onIos)).toBeOnTheScreen();
  expect(onNext).not.toHaveBeenCalled();
  await press('reminder-continue');
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(native.calls.some((c) => c.startsWith('startCapture'))).toBe(false);
});

test('Android: silent, often as you park; no location asked', async () => {
  const { adapter } = await setup('android');
  expect(screen.getByText(`• ${copy.android}`)).toBeOnTheScreen();
  await press('reminder-turn-on');
  expect(adapter.log).toEqual(['snapshot']);
  expect(screen.getByText(reminderCopy.lines.onAndroid)).toBeOnTheScreen();
});

test('a phone with no Play services: the line says so, and Continue; nothing is asked or turned on', async () => {
  const native = createFakeDriveSense({ platform: 'android' });
  native.setTripReminderEnv({ available: false });
  const adapter = fakeAdapter(snap());
  const onNext = jest.fn();
  await render(
    <ThemeProvider>
      <ReminderStep ctx={ctx('android')} onNext={onNext} deps={{ adapter, native }} />
    </ThemeProvider>
  );
  expect(await screen.findByText(reminderCopy.lines.unavailable)).toBeOnTheScreen();
  expect(screen.queryByTestId('reminder-turn-on')).toBeNull();
  await press('reminder-continue');
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(adapter.log).toEqual([]);
  expect(native.calls).toEqual([]);
  expect(native.tripReminderOn).toBe(false);
});

test('Back to the step with the reminder already on: where it stands, and Continue (no second Turn on)', async () => {
  const native = createFakeDriveSense({ platform: 'android' });
  await native.setTripReminder(true);
  const adapter = fakeAdapter(snap());
  const onNext = jest.fn();
  await render(
    <ThemeProvider>
      <ReminderStep ctx={ctx('android')} onNext={onNext} deps={{ adapter, native }} />
    </ThemeProvider>
  );
  expect(await screen.findByText(reminderCopy.lines.onAndroid)).toBeOnTheScreen();
  expect(screen.queryByTestId('reminder-turn-on')).toBeNull();
  await press('reminder-continue');
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(adapter.log).toEqual([]);
  expect(native.calls).toEqual(['setTripReminder:true']);
});

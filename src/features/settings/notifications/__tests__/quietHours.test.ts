import { SIGN_OUT_SETTINGS } from '@/boot/device';
import { memoryDb } from '@/features/permissions/__fixtures__/harness';
import { createSettingsRepo } from '@/data/db';
import { COMMUTE_HEADS_UP_KEY, commuteHeadsUpOn, readCommuteHeadsUp, writeCommuteHeadsUp } from '@/features/weather/commuteSetting';

import {
  DEFAULT_QUIET_HOURS,
  hasQuietHours,
  minutesOfClock,
  parseQuietHours,
  QUIET_HOURS_KEY,
  quietOf,
  quietOfAnswer,
  readQuietHours,
  rememberQuietHours,
} from '../quietHours';

it('reads HH:MM only', () => {
  expect(minutesOfClock('00:00')).toBe(0);
  expect(minutesOfClock('07:30')).toBe(450);
  expect(minutesOfClock('23:59')).toBe(1439);
  expect(minutesOfClock('24:00')).toBeNull();
  expect(minutesOfClock('7:30')).toBeNull();
  expect(minutesOfClock('07:30:00')).toBeNull();
});

it('reads the stored copy leniently', () => {
  expect(parseQuietHours({ enabled: true, start: '21:00', end: '06:00' })).toEqual({ enabled: true, start: '21:00', end: '06:00' });
  expect(parseQuietHours({ enabled: 'yes', start: '21:00', end: '06:00' })).toBeNull();
  expect(parseQuietHours({ enabled: true, start: '9pm', end: '06:00' })).toBeNull();
  expect(parseQuietHours(null)).toBeNull();
  expect(parseQuietHours('x')).toBeNull();
});

it('takes the quiet hours out of the prefs and of an RPC answer', () => {
  const prefs = { weekly_recap: true, social: true, quiet_enabled: false, quiet_start: '22:00', quiet_end: '07:00', tz: null };
  expect(quietOf(prefs)).toEqual({ enabled: false, start: '22:00', end: '07:00' });
  expect(quietOfAnswer(prefs)).toEqual({ enabled: false, start: '22:00', end: '07:00' });
  expect(quietOfAnswer(null)).toBeNull();
  expect(quietOfAnswer({ ok: true })).toBeNull();
});

it('with no copy, the server’s default: on from 10 PM to 7 AM', async () => {
  const settings = createSettingsRepo(memoryDb());
  expect(DEFAULT_QUIET_HOURS).toEqual({ enabled: true, start: '22:00', end: '07:00' });
  expect(await readQuietHours(settings)).toEqual(DEFAULT_QUIET_HOURS);
  await settings.set(QUIET_HOURS_KEY, { broken: true });
  expect(await readQuietHours(settings)).toEqual(DEFAULT_QUIET_HOURS);
  await rememberQuietHours(settings, { enabled: false, start: '23:00', end: '06:00' });
  expect(await readQuietHours(settings)).toEqual({ enabled: false, start: '23:00', end: '06:00' });
});

it('writes the copy only when it changed, and says when the hours a heads-up keeps to did', async () => {
  const store = { get: jest.fn(async () => ({ enabled: true, start: '22:00', end: '07:00' }) as never), set: jest.fn(async () => {}) };
  expect(await rememberQuietHours(store, { enabled: true, start: '22:00', end: '07:00' })).toBe(false);
  expect(store.set).not.toHaveBeenCalled();
  expect(await rememberQuietHours(store, { enabled: true, start: '22:00', end: '08:00' })).toBe(true);
  expect(store.set).toHaveBeenCalledWith(QUIET_HOURS_KEY, { enabled: true, start: '22:00', end: '08:00' });
  // No copy: the default was in force, so the same hours stored change nothing.
  const settings = createSettingsRepo(memoryDb());
  expect(await hasQuietHours(settings)).toBe(false);
  expect(await rememberQuietHours(settings, DEFAULT_QUIET_HOURS)).toBe(false);
  expect(await hasQuietHours(settings)).toBe(true);
  expect(await rememberQuietHours(settings, { ...DEFAULT_QUIET_HOURS, enabled: false })).toBe(true);
});

it('the heads-up switch is on until stored off', async () => {
  const settings = createSettingsRepo(memoryDb());
  expect(await readCommuteHeadsUp(settings)).toBe(true);
  await writeCommuteHeadsUp(settings, false);
  expect(await readCommuteHeadsUp(settings)).toBe(false);
  await writeCommuteHeadsUp(settings, true);
  expect(await readCommuteHeadsUp(settings)).toBe(true);
  expect(commuteHeadsUpOn(null)).toBe(true);
  expect(commuteHeadsUpOn('false')).toBe(true);
});

it('both leave the phone with the driver at sign-out', () => {
  expect(SIGN_OUT_SETTINGS).toEqual(expect.arrayContaining([COMMUTE_HEADS_UP_KEY, QUIET_HOURS_KEY]));
});

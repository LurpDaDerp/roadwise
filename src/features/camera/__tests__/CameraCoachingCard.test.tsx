import { screen } from '@testing-library/react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { tripRow } from '@/data/queries/__fixtures__/rows';
import { clearQueryClients, world } from '@/features/trips/__fixtures__/render';

import { CameraCoachingCard, coachingLines } from '../CameraCoachingCard';
import { COACHING_INDEX_KEY, COACHING_KEY_PREFIX, KEEP_TRIPS, readCoaching, saveCoaching, type CameraCoaching } from '../coaching';
import { cameraCopy } from '../copy';

const copy = cameraCopy.coaching;
const card = (over: Partial<CameraCoaching> = {}): CameraCoaching => ({
  v: 1,
  seenPct: 92,
  cameraSession: 'good',
  glancesOver2s: 0,
  longestGlanceS: null,
  distractionAlerts: 0,
  sleepAlerts: 0,
  ...over,
});

afterEach(clearQueryClients);

test('a clean drive: the share seen, no long looks, the praise', () => {
  expect(coachingLines(card())).toEqual({ facts: [copy.seen(92), copy.longGlances(0)], tip: copy.clean });
});

test('long looks away: counted, the longest, the glance tip', () => {
  expect(coachingLines(card({ glancesOver2s: 3, longestGlanceS: 3.4, distractionAlerts: 1 }))).toEqual({
    facts: [copy.seen(92), copy.longGlances(3), copy.longestGlance(3.4), copy.distractionAlerts(1)],
    tip: copy.tipGlances,
  });
});

test('sleep alerts win the tip; a limited session says how to mount', () => {
  expect(coachingLines(card({ sleepAlerts: 1, glancesOver2s: 1, longestGlanceS: 2.2 })).tip).toBe(copy.tipSleep);
  expect(coachingLines(card({ cameraSession: 'limited', seenPct: null })).tip).toBe(copy.limited);
});

test('the card shows for a drive the camera saw, and not for any other', async () => {
  const w = await world({ trips: [tripRow({ client_trip_id: 'seen' }), tripRow({ client_trip_id: 'unseen' })] });
  await saveCoaching(createSettingsRepo(w.db), 'seen', card({ glancesOver2s: 1, longestGlanceS: 2.5 }));
  await w.renderScreen(<CameraCoachingCard clientTripId="seen" />);
  expect(await screen.findByText(copy.title)).toBeOnTheScreen();
  expect(screen.getByText(copy.longGlances(1))).toBeOnTheScreen();
  expect(screen.getByTestId('camera-coaching-tip')).toHaveTextContent(copy.tipGlances);
  clearQueryClients();
  await w.renderScreen(<CameraCoachingCard clientTripId="unseen" />);
  await new Promise<void>((r) => setTimeout(r, 20));
  expect(screen.queryByTestId('camera-coaching-card')).toBeNull();
});

test('only the newest KEEP_TRIPS cards are kept; a malformed record reads as none', async () => {
  const w = await world();
  const settings = createSettingsRepo(w.db);
  for (let i = 0; i < KEEP_TRIPS + 2; i++) await saveCoaching(settings, `t${i}`, card());
  await expect(readCoaching(settings, 't0')).resolves.toBeNull();
  await expect(readCoaching(settings, 't1')).resolves.toBeNull();
  await expect(readCoaching(settings, `t${KEEP_TRIPS + 1}`)).resolves.toEqual(card());
  expect(await settings.get<string[]>(COACHING_INDEX_KEY)).toHaveLength(KEEP_TRIPS);
  await settings.set(`${COACHING_KEY_PREFIX}bad`, { v: 2 });
  await expect(readCoaching(settings, 'bad')).resolves.toBeNull();
});

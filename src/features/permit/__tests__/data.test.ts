/** @jest-environment node */
/**
 * Permit mode's settings (each checked on its own, the start day set the first time it is turned
 * on), the log's drives as read from SQLite, one drive's supervisor, and the finalize dependency.
 */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { archiveDue, RETENTION_MS } from '@/data/db/archive';
import { createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { dayKey } from '@/lib/time';

import { keepArchivedNight, permitFinalizeDeps, readPracticeCandidates, writeDriveSupervisor } from '../data';
import { practiceLog } from '../log';
import { ARCHIVED_NIGHT_KEY, DRIVE_SUPERVISORS_KEY, EMPTY_NOTES, parseNight, parseSupervisors, readPracticeNotes, writeSupervisorNote } from '../notes';
import {
  cleanName,
  cleanTarget,
  cleanTargets,
  DEFAULT_PERMIT,
  parsePermit,
  PERMIT_KEYS,
  readPermit,
  writeDriverName,
  writePermitEnabled,
  writePermitState,
  writeStartDay,
  writeSupervisor,
  writeTargets,
} from '../prefs';

let db: Db;
let settings: ReturnType<typeof createSettingsRepo>;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  settings = createSettingsRepo(db);
});

const NOW = new Date(2026, 10, 6, 12, 0).getTime();
const TODAY = dayKey(new Date(NOW));

describe('settings', () => {
  test('unset, everything reads as off; anything malformed reads as unset', async () => {
    expect(await readPermit(settings)).toEqual(DEFAULT_PERMIT);
    expect(
      parsePermit({
        [PERMIT_KEYS.enabled]: 'yes',
        [PERMIT_KEYS.startDay]: '6 Nov',
        [PERMIT_KEYS.state]: { code: 'ZZ', auto: 'no' },
        [PERMIT_KEYS.targets]: 'lots',
        [PERMIT_KEYS.supervisor]: 42,
        [PERMIT_KEYS.driverName]: '   ',
      })
    ).toEqual(DEFAULT_PERMIT);
    const failing = { getMany: () => Promise.reject(new Error('locked')) } as unknown as typeof settings;
    expect(await readPermit(failing)).toEqual(DEFAULT_PERMIT);
  });

  test('turning it on starts the log today; off and on again keeps the start day', async () => {
    await writePermitEnabled(settings, true, NOW);
    expect(await readPermit(settings)).toMatchObject({ enabled: true, startDay: TODAY });
    await writePermitEnabled(settings, false, NOW + 86_400_000 * 3);
    await writePermitEnabled(settings, true, NOW + 86_400_000 * 3);
    expect(await readPermit(settings)).toMatchObject({ enabled: true, startDay: TODAY });
  });

  test('the start day moves earlier freely; a day after today is today', async () => {
    await writeStartDay(settings, '2026-09-01', NOW);
    expect((await readPermit(settings)).startDay).toBe('2026-09-01');
    await writeStartDay(settings, '2027-01-01', NOW);
    expect((await readPermit(settings)).startDay).toBe(TODAY);
    await writeStartDay(settings, 'soon', NOW);
    expect((await readPermit(settings)).startDay).toBe(TODAY);
  });

  test('the state: chosen or detected, an unknown code none', async () => {
    await writePermitState(settings, 'or', false);
    expect((await readPermit(settings)).state).toEqual({ code: 'OR', auto: false });
    await writePermitState(settings, null, true);
    expect((await readPermit(settings)).state).toEqual({ code: null, auto: true });
    await writePermitState(settings, 'XX', true);
    expect((await readPermit(settings)).state).toEqual({ code: null, auto: true });
  });

  test("targets: above 0 to a tenth, at most 999, night at most the total; null goes back to the state's", async () => {
    expect(cleanTarget(50)).toBe(50);
    expect(cleanTarget(12.345)).toBe(12.3);
    expect(cleanTarget(0)).toBeNull();
    expect(cleanTarget(-4)).toBeNull();
    expect(cleanTarget(5000)).toBe(999);
    expect(cleanTarget(Number.NaN)).toBeNull();
    expect(cleanTargets({ totalH: 40, nightH: 60 })).toEqual({ totalH: 40, nightH: 40 });
    expect(cleanTargets({ totalH: null, nightH: 10 })).toEqual({ totalH: null, nightH: 10 });
    await writeTargets(settings, { totalH: 40, nightH: 15 });
    expect((await readPermit(settings)).targets).toEqual({ totalH: 40, nightH: 15 });
    await writeTargets(settings, { totalH: null, nightH: null });
    expect((await readPermit(settings)).targets).toEqual({ totalH: null, nightH: null });
    await writeTargets(settings, null);
    expect((await readPermit(settings)).targets).toBeNull();
  });

  test('names: trimmed, at most 60 characters; empty removes them', async () => {
    expect(cleanName('  Dad ')).toBe('Dad');
    expect(cleanName('x'.repeat(80))).toHaveLength(60);
    await writeSupervisor(settings, ' Aunt Jo ');
    await writeDriverName(settings, 'Sam Lee');
    expect(await readPermit(settings)).toMatchObject({ supervisor: 'Aunt Jo', driverName: 'Sam Lee' });
    await writeSupervisor(settings, '  ');
    await writeDriverName(settings, '');
    expect(await readPermit(settings)).toMatchObject({ supervisor: null, driverName: null });
    expect(await settings.get(PERMIT_KEYS.supervisor)).toBeNull();
  });
});

describe('the drives and their supervisors', () => {
  const trips = () => createTripsRepo(db);
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).getTime();

  test('the candidates: every kept kind from two days before the start day, newest first, archived ones too', async () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await trips().insert({ client_trip_id: 'old', started_at: at(1, 12), tz, status: 'scored' }, NOW);
    await trips().insert({ client_trip_id: 'edge', started_at: at(3, 12), tz, status: 'scored' }, NOW);
    await trips().insert({ client_trip_id: 'new', started_at: at(5, 12), tz, status: 'pending' }, NOW);
    await trips().insert({ client_trip_id: 'gone', started_at: at(5, 13), tz, status: 'scored', archived_at: NOW }, NOW);
    await trips().insert({ client_trip_id: 'marked', started_at: at(5, 14), tz, status: 'not_driving' }, NOW);
    await trips().insert({ client_trip_id: 'live', started_at: at(6, 11), tz, status: 'recording' }, NOW);
    const found = await readPracticeCandidates(db, '2026-11-05');
    expect(found.map((d) => d.clientTripId)).toEqual(['gone', 'new', 'edge']);
    expect(found[0]?.archived).toBe(true);
  });

  test("a drive's supervisor is written to its row and the kept map, cleaned; a drive not on the phone is false", async () => {
    await trips().insert({ client_trip_id: 'd', started_at: NOW, tz: 'UTC', status: 'scored' }, NOW);
    expect(await writeDriveSupervisor(db, 'd', '  Coach Kim  ', NOW)).toBe(true);
    expect((await trips().get('d'))?.practice_supervisor).toBe('Coach Kim');
    expect((await readPracticeNotes(settings)).supervisors).toEqual({ d: 'Coach Kim' });
    expect(await writeDriveSupervisor(db, 'd', '', NOW)).toBe(true);
    expect((await trips().get('d'))?.practice_supervisor).toBeNull();
    expect((await readPracticeNotes(settings)).supervisors).toEqual({});
    expect(await writeDriveSupervisor(db, 'nope', 'Dad', NOW)).toBe(false);
    expect((await readPracticeNotes(settings)).supervisors).toEqual({});
  });

  test('at finalize: the saved supervisor for a drive in the log (kept in the map too); none when off, before the start day, or unset', async () => {
    const { practiceSupervisor } = permitFinalizeDeps(db);
    expect(await practiceSupervisor({ clientTripId: 'a', localDay: '2026-11-06' })).toBeNull();
    await writePermitEnabled(settings, true, NOW);
    expect(await practiceSupervisor({ clientTripId: 'a', localDay: TODAY })).toBeNull();
    await writeSupervisor(settings, 'Dad');
    expect(await practiceSupervisor({ clientTripId: 'b', localDay: TODAY })).toBe('Dad');
    expect(await practiceSupervisor({ clientTripId: 'c', localDay: '2026-01-01' })).toBeNull();
    await writePermitEnabled(settings, false, NOW);
    expect(await practiceSupervisor({ clientTripId: 'd', localDay: TODAY })).toBeNull();
    expect((await readPracticeNotes(settings)).supervisors).toEqual({ b: 'Dad' });
  });

  test("a sign-out loses the rows' supervisors; the kept map still names them", async () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await writePermitEnabled(settings, true, NOW);
    await writeSupervisor(settings, 'Dad');
    const row = { client_trip_id: 'm', started_at: NOW - 3_600_000, ended_at: NOW - 1_800_000, duration_s: 1800, tz, status: 'scored' as const };
    await trips().insert(row, NOW);
    await writeDriveSupervisor(db, 'm', 'Mom', NOW);
    // The plain sign-out deletes the drives; the restore brings this one back without the column.
    await db.execute('DELETE FROM trips');
    await trips().insert(row, NOW);
    const prefs = await readPermit(settings);
    const drives = await readPracticeCandidates(db, TODAY);
    expect(drives[0]?.practiceSupervisor).toBeNull();
    expect(practiceLog(drives, prefs).rows[0]?.supervisor).toBe('Dad');
    expect(practiceLog(drives, prefs, await readPracticeNotes(settings)).rows[0]?.supervisor).toBe('Mom');
  });
});

describe('what is kept beside the rows', () => {
  test('the maps: each entry checked on its own; anything malformed is dropped; a failed read is empty', async () => {
    expect(parseSupervisors({ a: ' Dad ', b: 42, c: '  ' })).toEqual({ a: 'Dad' });
    expect(parseSupervisors('x')).toEqual({});
    expect(parseNight({ a: { sunset: 1, dark30: 0, md30: 2.5 }, b: { sunset: 1 }, c: { sunset: -1, dark30: 0, md30: 0 }, d: null })).toEqual({ a: { sunset: 1, dark30: 0, md30: 2.5 } });
    expect(parseNight([1, 2])).toEqual({});
    const failing = { getMany: () => Promise.reject(new Error('locked')) } as unknown as typeof settings;
    expect(await readPracticeNotes(failing)).toEqual(EMPTY_NOTES);
    await settings.set(DRIVE_SUPERVISORS_KEY, { x: 'Jo', y: 7 });
    await writeSupervisorNote(settings, 'z', ' Kim ');
    expect(await settings.get(DRIVE_SUPERVISORS_KEY)).toEqual({ x: 'Jo', z: 'Kim' });
    await writeSupervisorNote(settings, 'x', null);
    expect(await settings.get(DRIVE_SUPERVISORS_KEY)).toEqual({ z: 'Kim' });
  });

  test("before the archive: a due drive's night under every rule is kept, so its split survives losing its position", async () => {
    const trips = createTripsRepo(db);
    // A Seattle drive across sunset on June 21 2026 (sunset 9:11 PM PDT), archived after 183 days.
    const startedAt = Date.parse('2026-06-22T03:41:00Z');
    const endedAt = startedAt + 60 * 60_000;
    const archiveAt = endedAt + RETENTION_MS + 86_400_000;
    const row = { started_at: startedAt, ended_at: endedAt, duration_s: 3600, miles: 20, night_miles: 15, tz: 'America/Los_Angeles', start_lat: 47.6, start_lng: -122.33, end_lat: 47.7, end_lng: -122.3 };
    await trips.insert({ client_trip_id: 'dusk', status: 'scored', ...row }, startedAt);
    await trips.insert({ client_trip_id: 'marked', status: 'not_driving', ...row }, startedAt);
    // Permit mode never turned on: nothing kept.
    expect(await keepArchivedNight(db, archiveAt)).toBe(0);
    await settings.set(PERMIT_KEYS.startDay, '2026-06-01');
    await settings.set(PERMIT_KEYS.enabled, true);
    await settings.set(PERMIT_KEYS.state, { code: 'CA', auto: false });
    const prefs = await readPermit(settings);
    const before = practiceLog(await readPracticeCandidates(db, '2026-06-01'), prefs).totals;
    // Not due yet: nothing kept.
    expect(await keepArchivedNight(db, endedAt + 86_400_000)).toBe(0);
    expect(await keepArchivedNight(db, archiveAt)).toBe(1);
    expect(Object.keys((await readPracticeNotes(settings)).night)).toEqual(['dusk']);
    // Kept once: a second run adds nothing.
    expect(await keepArchivedNight(db, archiveAt)).toBe(0);
    expect(await archiveDue(db, archiveAt)).toBe(2);
    const archived = await readPracticeCandidates(db, '2026-06-01');
    expect(archived[0]).toMatchObject({ clientTripId: 'dusk', archived: true });
    expect(archived[0]?.start).toBeUndefined();
    // With the kept minutes the totals are what they were (dark30, California); without them, the night-miles share.
    expect(practiceLog(archived, prefs, await readPracticeNotes(settings)).totals).toEqual(before);
    expect(practiceLog(archived, prefs).totals.nightMin).toBe(45);
    expect(before.nightMin).toBeLessThan(45);
    expect(await settings.get(ARCHIVED_NIGHT_KEY)).toEqual({ dusk: expect.objectContaining({ sunset: expect.any(Number), dark30: expect.any(Number), md30: expect.any(Number) }) });
  });
});

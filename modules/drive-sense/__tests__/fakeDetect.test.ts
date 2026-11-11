/** @jest-environment node */
// The in-memory drive detector the host and bootstrap tests run against (plan §3.1.1). It must
// follow the contract, or every adopt test built on it proves the wrong thing. Also: with no native
// module (this suite stubs none), the real `DriveDetect` is unavailable and inert.
import { DriveDetect } from '../src/detect';
import { readJournal } from '../src/detect/journal';
import { DETECT } from '../src/detect/policy';
import { createFakeDriveSense } from '../src/fake';
import { createFakeDriveDetect } from '../src/fakeDetect';
import type { DriveStartedEvent } from '../src/detect/types';

const OWNER = '3b2e4c1a-1111-4222-8333-444455556666';
const row = (ts: number) => ({ ts, speed: 9, lat: 47.6, lng: -122.33 });

test('the real wrapper with no native module: unavailable, every method but wipe rejects, listeners inert', async () => {
  expect(DriveDetect.available).toBe(false);
  await expect(DriveDetect.getState()).rejects.toThrow('DriveDetect.getState: not available');
  await expect(DriveDetect.setArmed(true, OWNER)).rejects.toThrow('not available');
  // Android: the sign-out and device wipes call it all the same; there is nothing to wipe.
  await expect(DriveDetect.wipe()).resolves.toBeUndefined();
  expect(() => DriveDetect.addListener('driveStarted', () => {}).remove()).not.toThrow();
});

describe('the fake detector', () => {
  test('arming needs Always, Precise and Motion; the status says what is missing', async () => {
    const d = createFakeDriveDetect({ permissions: { location: 'whenInUse' } });
    const s = await d.setArmed(true, OWNER);
    expect(s).toMatchObject({ armed: false, state: 'off', status: 'needs', missing: ['locationAlways'], ownerId: OWNER });
    d.setPermissions({ location: 'always' });
    expect(await d.setArmed(true, OWNER)).toMatchObject({ armed: true, state: 'armed', status: 'on', missing: [] });
    expect(await d.setArmed(false, OWNER)).toMatchObject({ armed: false, state: 'off', status: 'off', ownerId: null });
  });

  test('a wake opens an auto candidate only when armed; a confirmation records, journals and emits', async () => {
    let now = 1_760_000_000_000;
    const sense = createFakeDriveSense();
    const seen: unknown[] = [];
    sense.addListener('row', (r) => seen.push(r));
    const d = createFakeDriveDetect({ now: () => now, sense });
    expect(d.wake()).toBe(false);
    await d.setArmed(true, OWNER);
    const states: string[] = [];
    d.addListener('detectState', (e) => states.push(`${e.reason}:${e.state}`));
    const started = jest.fn();
    d.addListener('driveStarted', started);
    expect(d.wake('region')).toBe(true);
    now += 45_000;
    const ev = d.confirm({ startedAt: now - 60_000, startLat: 47.6, startLng: -122.33, rows: [row(now - 60_000), row(now - 59_000)] });
    expect(started).toHaveBeenCalledWith(ev);
    expect(ev).toMatchObject({ origin: 'auto', startSource: 'trace', continues: false, confirmedAt: now, firstSeq: 1 });
    expect(states).toEqual(['wake:region:candidate', 'confirmed:recording']);
    expect(seen.map((r) => (r as { seq: number }).seq)).toEqual([1, 2]);
    expect(d.emitRows([row(now - 58_000)])).toEqual([3]);
    const state = await d.getState();
    expect(state).toMatchObject({ state: 'recording', driveId: ev.driveId, startedAt: now - 60_000 });
    const [listed] = await d.listDrives();
    expect(listed).toMatchObject({ driveId: ev.driveId, lastSeq: 3, lastRowTs: now - 58_000, ended: null });
  });

  test('readRows pages the journal by seq; discardDrive refuses the live drive', async () => {
    const d = createFakeDriveDetect();
    await d.setArmed(true, OWNER);
    const ev = d.confirm({ rows: Array.from({ length: 5 }, (_, i) => row(1000 + i * 1000)) });
    await expect(d.readRows(ev.driveId, 0, 2)).resolves.toMatchObject({ lastSeq: 2, done: false });
    await expect(d.readRows(ev.driveId, 2, 2)).resolves.toMatchObject({ lastSeq: 4, done: false });
    const last = await d.readRows(ev.driveId, 4, 2);
    expect(last).toMatchObject({ lastSeq: 5, done: true });
    expect(last.rows).toEqual([{ ...row(5000), seq: 5 }]);
    await expect(d.readRows(ev.driveId, 5, 2)).resolves.toEqual({ rows: [], lastSeq: 5, done: true });
    await expect(d.discardDrive(ev.driveId)).rejects.toMatchObject({ code: 'E_BUSY' });
    d.jsStop(4000);
    await expect(d.discardDrive(ev.driveId)).resolves.toBeUndefined();
    expect(d.journal.has(ev.driveId)).toBe(false);
    await expect(d.discardDrive(ev.driveId)).resolves.toBeUndefined();
  });

  test('a JS stop journals the end with cause js and the cut, emits no driveEnded, and arms again with the last end', async () => {
    let now = 1_760_000_000_000;
    const d = createFakeDriveDetect({ now: () => now });
    await d.setArmed(true, OWNER);
    const ended = jest.fn();
    d.addListener('driveEnded', ended);
    const ev = d.confirm();
    now += 600_000;
    d.jsStop(now - 300_000);
    expect(ended).not.toHaveBeenCalled();
    const s = await d.getState();
    expect(s).toMatchObject({ state: 'armed', driveId: null, lastEnd: { decidedAt: now, cut: now - 300_000, driveId: ev.driveId } });
    expect(readJournal(d.journal.get(ev.driveId)!).end).toMatchObject({ cause: 'js', endedAt: now - 300_000, decidedAt: now });
  });

  test('a native stop emits driveEnded; "Not driving?" deletes the journal and suppresses', async () => {
    const d = createFakeDriveDetect();
    await d.setArmed(true, OWNER);
    const ended: unknown[] = [];
    d.addListener('driveEnded', (e) => ended.push(e.cause));
    const a = d.confirm();
    d.endFor('walking');
    expect(readJournal(d.journal.get(a.driveId)!).end?.cause).toBe('walking');
    const b = d.confirm();
    await d.notDriving();
    expect(ended).toEqual(['walking', 'cancelled']);
    expect(d.journal.has(b.driveId)).toBe(false);
    const s = await d.getState();
    expect(s.state).toBe('suppressed');
    expect(s.suppressedUntil! - s.since).toBe(DETECT.SUPPRESS_MAX_MS);
    expect(d.wake('region')).toBe(false);
    await d.notDriving(); // nothing records: a no-op
    expect(ended).toHaveLength(2);
  });

  test('the Start card: needs While Using and Precise; opens a manual drive at the tap, waiting for driving speed; a touch extends the wait; busy while one records', async () => {
    let now = 1_000_000;
    const d = createFakeDriveDetect({ now: () => now, permissions: { location: 'none' } });
    await expect(d.startWaiting()).resolves.toEqual({ ok: false, reason: 'permission' });
    d.setPermissions({ location: 'whenInUse' });
    const started: DriveStartedEvent[] = [];
    d.addListener('driveStarted', (e) => started.push(e));
    const r = await d.startWaiting();
    expect(r).toEqual({ ok: true, waitUntil: now + DETECT.WAIT_MAX_MS, driveId: expect.any(String), startedAt: now });
    await Promise.resolve();
    expect(started).toEqual([expect.objectContaining({ driveId: r.ok ? r.driveId : '', origin: 'manual', startedAt: now, startSource: 'wake', continues: false })]);
    expect(await d.getState()).toMatchObject({ state: 'recording', origin: 'manual', waitUntil: now + DETECT.WAIT_MAX_MS });
    expect((await d.listDrives()).map((j) => j.driveId)).toEqual([r.ok ? r.driveId : '']);
    now += 60_000;
    await expect(d.extendWaiting()).resolves.toBe(now + DETECT.WAIT_MAX_MS);
    await expect(d.startWaiting()).resolves.toEqual({ ok: false, reason: 'busy' });
    d.waitOver();
    await expect(d.extendWaiting()).resolves.toBeNull();
    expect((await d.getState()).waitUntil).toBeNull();
    d.jsStop(now);
    await expect(d.extendWaiting()).resolves.toBeNull();
    // A relaunch during the wait ends it, as native's resume does (JS takes the drive back without one).
    expect(await d.startWaiting()).toMatchObject({ ok: true });
    expect(d.relaunch()).not.toBeNull();
    expect((await d.getState()).waitUntil).toBeNull();
    await expect(d.extendWaiting()).resolves.toBeNull();
  });

  test('appForeground: an app wake opens an auto candidate only with fresh car motion, ignoring nothing else; a no-op without the module', async () => {
    const d = createFakeDriveDetect();
    const states: string[] = [];
    d.addListener('detectState', (e) => states.push(`${e.reason}:${e.state}`));
    await d.appForeground();
    expect((await d.getState()).state).toBe('off');
    await d.setArmed(true, OWNER);
    await d.appForeground();
    expect((await d.getState()).state).toBe('armed');
    d.setCarMotion(true);
    await d.appForeground();
    expect((await d.getState()).state).toBe('candidate');
    expect(states).toEqual(['armed:armed', 'wake:app:candidate']);
    // watching already: nothing more
    await d.appForeground();
    expect(states).toHaveLength(2);
    d.confirm();
    await d.appForeground();
    expect((await d.getState()).state).toBe('recording');
    expect(d.calls.filter((c) => c === 'appForeground')).toHaveLength(5);
    const off = createFakeDriveDetect({ available: false });
    off.setCarMotion(true);
    await expect(off.appForeground()).resolves.toBeUndefined();
  });

  test('requestAlways answers once from While Using; an unavailable fake rejects everything', async () => {
    const d = createFakeDriveDetect({ permissions: { location: 'whenInUse', canAskAlways: true } });
    d.setAlwaysAnswer('always');
    await expect(d.requestAlways()).resolves.toBe('always');
    expect((await d.getState()).permissions).toMatchObject({ location: 'always', canAskAlways: false });
    const off = createFakeDriveDetect({ available: false });
    expect(off.available).toBe(false);
    await expect(off.getState()).rejects.toThrow('not available');
    await expect(off.listDrives()).rejects.toThrow('not available');
  });

  test('wipe: the drive stops unannounced, every journal goes, the last end, the rest and the owner are forgotten, and it is off', async () => {
    let now = 1_760_000_000_000;
    const d = createFakeDriveDetect({ now: () => now });
    await d.setArmed(true, OWNER);
    const ended = jest.fn();
    d.addListener('driveEnded', ended);
    const reasons: string[] = [];
    d.addListener('detectState', (e) => reasons.push(`${e.reason}:${e.state}`));
    const first = d.confirm({ rows: [row(now)] });
    now += 60_000;
    d.jsStop(now);
    const second = d.confirm({ rows: [row(now)] });
    expect([...d.journal.keys()]).toEqual([first.driveId, second.driveId]);
    expect((await d.getState()).lastEnd).not.toBeNull();
    d.setJournalDropped(1);
    reasons.length = 0;
    await expect(d.wipe()).resolves.toBeUndefined();
    expect(d.journal.size).toBe(0);
    await expect(d.listDrives()).resolves.toEqual([]);
    expect(await d.getState()).toMatchObject({ armed: false, ownerId: null, state: 'off', origin: null, driveId: null, startedAt: null, waitUntil: null, lastEnd: null, suppressedUntil: null, status: 'off', journalDropped: 0 });
    expect(ended).not.toHaveBeenCalled();
    expect(reasons).toEqual(['disarmed:off']);
    // Nothing starts again until JS arms it for an owner.
    expect(d.wake('region')).toBe(false);
    expect(await d.setArmed(true, OWNER)).toMatchObject({ armed: true, state: 'armed', lastEnd: null });
  });

  test('wipe: a rest ends; a Start-card wait is cancelled; an unavailable fake resolves', async () => {
    const d = createFakeDriveDetect();
    const reasons: string[] = [];
    d.addListener('detectState', (e) => reasons.push(e.reason));
    await d.setArmed(true, OWNER);
    d.confirm();
    await d.notDriving();
    expect((await d.getState()).state).toBe('suppressed');
    await d.wipe();
    expect(await d.getState()).toMatchObject({ state: 'off', suppressedUntil: null, ownerId: null });
    await d.startWaiting();
    reasons.length = 0;
    await d.wipe();
    expect(reasons).toEqual(['disarmed']);
    expect(await d.extendWaiting()).toBeNull();
    const off = createFakeDriveDetect({ available: false });
    await expect(off.wipe()).resolves.toBeUndefined();
    expect(off.calls).toEqual(['wipe']);
  });

  test('events nobody listens for are buffered and delivered when the first listener attaches', async () => {
    const d = createFakeDriveDetect();
    await d.setArmed(true, OWNER);
    const ev = d.confirm();
    const got = jest.fn();
    d.addListener('driveStarted', got);
    expect(got).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(got).toHaveBeenCalledWith(ev);
  });

  test('a journal with no end that is not the live drive (an orphan) lists as ended, cause orphan, at its last row; the live one does not', async () => {
    const d = createFakeDriveDetect();
    await d.setArmed(true, OWNER);
    const orphan = '0f8fad5b-d9cb-469f-a165-70867728950e';
    d.putJournal(
      orphan,
      [
        { k: 'start', v: 1, driveId: orphan, origin: 'manual', startedAt: 1_000, startSource: 'trace', startLat: 47.6, startLng: -122.33, continues: false, confirmedAt: 2_000, nativeBuild: '1' },
        { k: 'row', seq: 1, ts: 3_000 },
        { k: 'row', seq: 2, ts: 4_000 },
      ]
        .map((l) => `${JSON.stringify(l)}\n`)
        .join('')
    );
    const live = d.confirm({ rows: [row(5_000)] });
    const listed = await d.listDrives();
    expect(listed.find((x) => x.driveId === orphan)).toMatchObject({ origin: 'manual', lastSeq: 2, lastRowTs: 4_000, ended: { endedAt: 4_000, cause: 'orphan', decidedAt: 4_000 } });
    expect(listed.find((x) => x.driveId === live.driveId)?.ended).toBeNull();
    // Taken in and finalized by JS, it goes like any other.
    await expect(d.discardDrive(orphan)).resolves.toBeUndefined();
    expect((await d.listDrives()).map((x) => x.driveId)).toEqual([live.driveId]);
  });

  test('a relaunch after a power loss resumes the seqs past a gap: no row JS already took in has its seq handed out again (review M7)', async () => {
    let now = 1_760_000_000_000;
    const d = createFakeDriveDetect({ now: () => now });
    await d.setArmed(true, OWNER);
    const ev = d.confirm({ rows: Array.from({ length: 40 }, (_, i) => row(now - 40_000 + i * 1000)) });
    // JS took in seq 1-40 live; the power loss took the last 10 from the file before they were synced.
    let jsLast = 40;
    now += 120_000;
    expect(d.relaunch(10)).toBe(30 + DETECT.RESUME_SEQ_GAP);
    expect(d.emitRows([row(now), row(now + 1000), row(now + 2000)])).toEqual([1031, 1032, 1033]);
    // A gap-fill read after JS's last seq (as the host does) hands every new row over, none as a repeat.
    const page = await d.readRows(ev.driveId, jsLast, 300);
    const taken = page.rows.map((r) => (r as { seq: number }).seq).filter((seq) => seq > jsLast);
    expect(taken).toEqual([1031, 1032, 1033]);
    jsLast = page.lastSeq;
    expect(jsLast).toBe(1033);
    // The whole file: the durable rows, then the rows past the gap.
    const all = await d.readRows(ev.driveId, 0, 600);
    expect(all.rows.map((r) => (r as { seq: number }).seq)).toEqual([...Array.from({ length: 30 }, (_, i) => i + 1), 1031, 1032, 1033]);
    expect((await d.listDrives())[0]).toMatchObject({ lastSeq: 1033, ended: null });
    // A second relaunch before any new row reaches the file goes on past the first one's reservation.
    expect(d.relaunch(3)).toBe(1030 + DETECT.RESUME_SEQ_GAP);
    expect(d.emitRows([row(now + 3000)])).toEqual([2031]);
  });

  test('a journal left by an earlier process lists with its end, and getState clears journalDropped', async () => {
    const d = createFakeDriveDetect();
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    d.putJournal(
      id,
      [
        { k: 'start', v: 1, driveId: id, origin: 'auto', startedAt: 1, startSource: 'motion', startLat: null, startLng: null, continues: true, confirmedAt: 2, nativeBuild: '1' },
        { k: 'row', seq: 1, ts: 3 },
        { k: 'end', endedAt: 9, cause: 'orphan', decidedAt: 9, lastRowTs: 3, lastSeq: 1 },
      ]
        .map((l) => `${JSON.stringify(l)}\n`)
        .join('')
    );
    await expect(d.listDrives()).resolves.toEqual([
      expect.objectContaining({ driveId: id, startSource: 'motion', continues: true, lastSeq: 1, lastRowTs: 3, ended: { endedAt: 9, cause: 'orphan', decidedAt: 9 } }),
    ]);
    d.setJournalDropped(2);
    expect((await d.getState()).journalDropped).toBe(2);
    expect((await d.getState()).journalDropped).toBe(0);
    expect(d.calls).toEqual(['listDrives', 'getState', 'getState']);
  });
});

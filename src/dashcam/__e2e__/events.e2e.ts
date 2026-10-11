/** @jest-environment node */
// Events end to end (plan §3.6, §7.5; §10 rows 11–13, 25): the firmware's event ring, HELLO/RESUME
// replay and ACK handling (simulator) against the app's persistence (sql.js, the real SQLite engine):
// persist-then-ACK, the cursor and floor, replay exactly once, dedupe, crash, reboot, ring overflow.
import { CAM, EPOCH0, linkedA, scenario, type Phone, type World } from './world';
import { describeSim } from './suite';

const BOOT = 'c0ffee01';
const BOOT_ID = 0xc0ffee01;

interface StoredRow {
  boot_id: number;
  seq: number;
  id: string;
  ev: number;
  name: string;
  tier: number;
  audible: number;
  detail: number;
  t_ms: number;
  dur_ds: number;
  value: number;
  at_ms: number | null;
}

async function stored(p: Phone): Promise<StoredRow[]> {
  const { rows } = await p.rawDb.execute(
    'SELECT boot_id, seq, id, ev, name, tier, audible, detail, t_ms, dur_ds, value, at_ms FROM dashcam_events WHERE dashcam_id = ? ORDER BY boot_id, seq',
    [CAM]
  );
  return rows as unknown as StoredRow[];
}

async function boots(p: Phone): Promise<{ boot_id: number; offset_ms: number | null; floor_seq: number; max_seq: number }[]> {
  const { rows } = await p.rawDb.execute('SELECT boot_id, offset_ms, floor_seq, max_seq FROM dashcam_boots WHERE dashcam_id = ? ORDER BY boot_id', [CAM]);
  return rows as never;
}

/** `n` engine events (LONG_GLANCE, audible tier 2), fired now on the dashcam. */
async function events(w: World, n: number, ev = 3): Promise<void> {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`EV ${ev} 2 1 0 ${w.uptime()} 35 35`);
  await w.dashcam(...lines);
}

const seqs = (w: World, conn: number, since = 0) => w.txOf('EVENT', conn, since).map((x) => x.f.seq);
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
/** The cumulative ACK the dashcam last heard (ACK or STATE). */
const lastAck = (w: World, conn: number) => {
  const acks = w.rx(conn).filter((x) => x.f.type === 'ACK' || x.f.type === 'STATE') as { f: { ackSeq: number } }[];
  return acks.at(-1)?.f.ackSeq ?? null;
};

describeSim('DashPal events (firmware ring ↔ app store)', () => {
  test('hello → RESUME → backfill: events from before the connect are held until RESUME, replayed from the cursor, persisted, then ACKed; wall times from the measured offset', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      await w.runTo(10_000);
      await w.dashcam('EV 0 3 1 4 9000 15 15', 'EV 1 3 1 0 9500 40 40', 'EV 2 3 1 2 9900 100 100', 'EV 31 0 0 5 9990 300 300', 'EV 12 1 0 0 9995 10 10');
      const a = await w.addPhone({ name: 'A', conn: 1, paired: true });
      const t0 = w.W;
      await w.connected(a);
      const resume = w.rxOf('RESUME', 1, t0);
      expect(resume.map((x) => x.f)).toEqual([{ type: 'RESUME', bootId: BOOT_ID, nextSeq: 0 }]);
      // Nothing of the ring before the RESUME, then all of it once.
      const hello = w.txOf('HELLO', 1, t0)[0]!;
      expect(hello.f).toMatchObject({ bootId: BOOT_ID, nextSeq: 5, oldestSeq: 0 });
      expect(w.txOf('EVENT', 1, t0).every((x) => x.at >= resume[0]!.at)).toBe(true);
      expect(seqs(w, 1, t0)).toEqual([0, 1, 2, 3, 4]);
      await w.advance(1500);
      const rows = await stored(a);
      expect(rows.map((r) => [r.boot_id, r.seq, r.ev, r.name, r.tier, r.audible, r.detail])).toEqual([
        [BOOT_ID, 0, 0, 'MICROSLEEP', 3, 1, 4],
        [BOOT_ID, 1, 1, 'SLEEP', 3, 1, 0],
        [BOOT_ID, 2, 2, 'UNRESPONSIVE', 3, 1, 2],
        [BOOT_ID, 3, 31, 'CRITICAL_STAND_DOWN', 0, 0, 5],
        [BOOT_ID, 4, 12, 'GLANCE', 1, 0, 0],
      ]);
      for (const r of rows) expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(rows.map((r) => r.value)).toEqual([1.5, 4, 10, 30, 1]);
      // With no latency the HELLO/TIME_PING offset is exact: epoch = EPOCH0 + boot + uptime.
      expect(rows.map((r) => r.at_ms)).toEqual(rows.map((r) => EPOCH0 + w.bootAt + r.t_ms));
      expect(lastAck(w, 1)).toBe(5);
      expect(a.rt.state().link.counters).toMatchObject({ stored: 5, duplicates: 0, orphanEvents: 0, storeErrors: 0 });
    }));

  test('row 12 and persist-then-ACK: while the inserts are stuck nothing is acknowledged; the app dies before persisting, the events come again after the relaunch and are stored once', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await events(w, 2);
      await w.advance(1500);
      expect(lastAck(w, 1)).toBe(2);
      const release = w.holdDb(a, /INSERT OR IGNORE INTO dashcam_events/);
      void release;
      const t0 = w.W;
      await events(w, 3);
      await w.advance(3000);
      expect(seqs(w, 1, t0)).toEqual([2, 3, 4]); // delivered …
      expect(lastAck(w, 1)).toBe(2); // … but never acknowledged: not persisted
      expect((await stored(a)).map((r) => r.seq)).toEqual([0, 1]);

      await w.crash(a); // the process dies with the inserts still pending
      await w.advance(2000);
      const t1 = w.W;
      const a2 = await w.addPhone({ name: 'A', conn: 1, paired: true, db: a.rawDb });
      await w.connected(a2);
      await w.advance(1500);
      expect(w.rxOf('RESUME', 1, t1).map((x) => x.f.nextSeq)).toEqual([2]);
      expect(seqs(w, 1, t1)).toEqual([2, 3, 4]); // re-sent from the cursor, once
      expect((await stored(a2)).map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
      expect(lastAck(w, 1)).toBe(5);
    }));

  test('row 11: events while out of range are replayed exactly once after the reconnect (RESUME from the cursor), nothing re-sent that was stored', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await events(w, 3);
      await w.advance(1500);
      await w.outOfRange(a);
      await w.advance(5000);
      await events(w, 5);
      await w.advance(5000);
      const t0 = w.W;
      await w.backInRange(a);
      await w.connected(a);
      await w.advance(1500);
      expect(w.rxOf('RESUME', 1, t0).map((x) => x.f.nextSeq)).toEqual([3]);
      expect(seqs(w, 1, t0)).toEqual([3, 4, 5, 6, 7]);
      expect((await stored(a)).map((r) => r.seq)).toEqual(range(0, 8));
      expect(a.rt.state().link.counters.duplicates).toBe(0);
      expect(lastAck(w, 1)).toBe(8);
      // Live events after the resync flow straight through.
      const t1 = w.W;
      await events(w, 1);
      await w.advance(500);
      expect(seqs(w, 1, t1)).toEqual([8]);
      expect(lastAck(w, 1)).toBe(9);
    }));

  test('row 11 dedupe: the phone is slow to answer HELLO (its database is busy), the dashcam sends the whole ring after 2 s; the copies already stored are ignored, each event stored once', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await events(w, 3);
      await w.advance(1500);
      await w.outOfRange(a);
      await events(w, 2);
      const release = w.holdDb(a, /dashcam_boots/);
      const t0 = w.W;
      await w.backInRange(a);
      await w.runTo(t0 + 2100);
      expect(w.rxOf('RESUME', 1, t0)).toEqual([]);
      const ring = w.txOf('EVENT', 1, t0);
      expect(ring.map((x) => x.f.seq)).toEqual([0, 1, 2, 3, 4]);
      expect(ring[0]!.at - t0).toBe(2000);
      await release();
      await w.advance(1500);
      // The boot row arrives first, so RESUME carries the cursor of that moment (3: the ring copies of
      // 3 and 4 are still queued behind it) and the dashcam sends 3 and 4 once more. Every copy after
      // the first is ignored: 0–2 from the ring, 3–4 from the RESUME.
      const resume = w.rxOf('RESUME', 1, t0);
      expect(resume.map((x) => x.f.nextSeq)).toEqual([3]);
      expect(seqs(w, 1, resume[0]!.at)).toEqual([3, 4]);
      expect((await stored(a)).map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
      expect(a.rt.state().link.counters).toMatchObject({ duplicates: 5, storeErrors: 0 });
      expect(lastAck(w, 1)).toBe(5);
    }));

  test('row 13: a dashcam reboot draws a new random boot id; the phone keeps both boots apart (same seqs, nothing dropped as a duplicate), each with its own offset', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await events(w, 3);
      await w.advance(1500);
      await w.outOfRange(a); // (so the two new events wait in the ring)
      await w.reboot({ gapMs: 7000 }); // no --boot-id: the simulator draws one, as the device does
      const newBoot = w.bootIdOf();
      expect(newBoot).not.toBe(BOOT_ID);
      expect(newBoot).not.toBe(0);
      await w.dashcam(`EV 5 2 1 0 ${w.uptime()} 40 40`, `EV 3 2 1 0 ${w.uptime()} 35 35`);
      const t0 = w.W;
      await w.backInRange(a);
      await w.connected(a, 5000);
      await w.advance(1500);
      expect(w.txOf('HELLO', 1, t0)[0]!.f).toMatchObject({ bootId: newBoot, nextSeq: 2 });
      expect(w.rxOf('RESUME', 1, t0).map((x) => x.f)).toEqual([{ type: 'RESUME', bootId: newBoot, nextSeq: 0 }]);
      const rows = await stored(a);
      expect(rows.map((r) => [r.boot_id, r.seq])).toEqual(
        [
          [BOOT_ID, 0],
          [BOOT_ID, 1],
          [BOOT_ID, 2],
          [newBoot, 0],
          [newBoot, 1],
        ].sort((x, y) => x[0]! - y[0]! || x[1]! - y[1]!)
      );
      expect(a.rt.state().link.counters.duplicates).toBe(0);
      const b = await boots(a);
      expect(b.map((x) => [x.boot_id, x.offset_ms]).sort((x, y) => x[0]! - y[0]!)).toEqual(
        [
          [BOOT_ID, EPOCH0],
          [newBoot, EPOCH0 + w.bootAt],
        ].sort((x, y) => x[0]! - y[0]!)
      );
      expect(lastAck(w, 1)).toBe(2);
    }));

  test('ring overflow while out of range: HELLO moves the floor past the lost events, RESUME starts at the oldest kept, the gap stays permanent and the ACK reaches next_seq', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await events(w, 2);
      await w.advance(1500);
      await w.outOfRange(a);
      await events(w, 300); // seq 2..301; the ring keeps the last 256
      const t0 = w.W;
      await w.backInRange(a);
      await w.connected(a);
      await w.advance(2000);
      expect(w.txOf('HELLO', 1, t0)[0]!.f).toMatchObject({ nextSeq: 302, oldestSeq: 46 });
      expect(w.rxOf('RESUME', 1, t0).map((x) => x.f.nextSeq)).toEqual([46]);
      expect(seqs(w, 1, t0)).toEqual(range(46, 302));
      const rows = (await stored(a)).map((r) => r.seq);
      expect(rows).toEqual([0, 1, ...range(46, 302)]);
      expect((await boots(a))[0]).toMatchObject({ floor_seq: 46, max_seq: 301 });
      expect(lastAck(w, 1)).toBe(302);
      expect(a.rt.state().link.synced).toBe(true);
    }));

  test('ring overflow on a live link (notifications refused, as with ENOMEM): the dashcam skips to the oldest kept and sends HELLO first; the phone moves its floor and catches up', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await events(w, 2);
      await w.advance(1500);
      await w.dashcam('BLOCK 1 1');
      await events(w, 300); // seq 2..301 queue up behind a congested link
      const t0 = w.W;
      await w.dashcam('BLOCK 1 0');
      await w.advance(2000);
      const out = w.tx(1, t0);
      const helloAt = out.findIndex((x) => x.f.type === 'HELLO');
      expect(helloAt).toBeGreaterThanOrEqual(0);
      expect(out[helloAt]!.f).toMatchObject({ type: 'HELLO', bootId: BOOT_ID, nextSeq: 302, oldestSeq: 46 });
      const evs = out.filter((x) => x.f.type === 'EVENT');
      expect(out.findIndex((x) => x.f.type === 'EVENT')).toBeGreaterThan(helloAt);
      expect(evs.map((x) => (x.f as { seq: number }).seq)).toEqual(range(46, 302));
      expect((await stored(a)).map((r) => r.seq)).toEqual([0, 1, ...range(46, 302)]);
      expect((await boots(a))[0]).toMatchObject({ floor_seq: 46 });
      expect(lastAck(w, 1)).toBe(302);
    }));

  test('row 25: malformed frames are ignored both ways (counted on the phone, dropped by the dashcam); longer frames are accepted', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.mark();
      // Phone → dashcam: short, unknown type, wrong version: no answer, no ERR, the link carries on.
      const t = a.transport();
      await t.write([0x86, 0x01, 0x07], { withResponse: true });
      await t.write([0x99, 0x01, 0x07, 0x00], { withResponse: true });
      await t.write([0x86, 0x02, 0x07, 0x00], { withResponse: true });
      await w.settle();
      expect(w.out(t0).map((l) => l.line)).toEqual([]);
      // A longer COMMAND 7 (trailing bytes ignored) is answered.
      await t.write([0x86, 0x01, 0x07, 0x00, 0xaa, 0xbb], { withResponse: true });
      await w.settle();
      expect(w.tx(1, t0).map((x) => x.f.type).slice(0, 2)).toEqual(['HELLO', 'STATUS']);
      // Dashcam → phone (injected: the firmware never sends these): short, unknown, version 2.
      const before = a.rt.state().link.counters.badFrames;
      a.ble.notify(a.peripheralId, [0x03, 0x01, 0x00]);
      a.ble.notify(a.peripheralId, [0x7f, 0x01, 0, 0, 0, 0]);
      a.ble.notify(a.peripheralId, [0x02, 0x02, 0, 0, 0, 0, 3, 0, 0, 0, 1]);
      // A STATUS with three trailing bytes is taken.
      a.ble.notify(a.peripheralId, [0x02, 0x01, 0, 0, 0, 0, 3, 0x48, 0xa0, 30, 1, 0xde, 0xad, 0xbe]);
      await w.settle();
      expect(a.rt.state().link.counters.badFrames - before).toBe(3);
      expect(a.rt.state().link.status).toMatchObject({ state: 3, flags: 0x48, fpsX10: 0xa0, tempC: 30, bondCount: 1 });
      expect(a.rt.state().link.lifecycle).toBe('connected');
      expect(w.lines('ERR')).toEqual([]);
    }));
});

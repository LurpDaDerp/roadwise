/** @jest-environment node */
// The re-aim flow (`reaim.ts`): the paired DashPal's live picture outside setup (firmware 3.6) —
// start, the first image, a stall and its retries, giving up, refusals, Done (the stop, once more
// when it fails, and COMMAND 2 when no picture ever came or the stop never went through), firmware
// too old, no link (the picture starting once it is up), RoadWise leaving the front, the link going
// down and coming back.
import type { LinkSnapshot } from '../link';
import { COMMAND, type AimFrame, type ViewStateFrame } from '../protocol';
import { createReaimFlow, REAIM_FIRST_MS, REAIM_GIVE_UP_MS, REAIM_STALL_MS, supportsReaim, type ReaimDeps, type ReaimPhase } from '../reaim';

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** One VIEW record holding a whole image `frame` of `data`. */
const record = (frame: number, data: number[]): number[] => [1, 1, frame, 0, data.length & 0xff, data.length >> 8, 0, 0, ...data];
const JPEG = [0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9];

function rig(o: { firmware?: string | null; lifecycle?: LinkSnapshot['lifecycle'] } = {}) {
  const sent: string[] = [];
  let viewFn: ((f: AimFrame | ViewStateFrame) => void) | null = null;
  let recordFn: ((r: number[]) => void) | null = null;
  const snap = { lifecycle: o.lifecycle ?? 'connected', firmware: o.firmware === undefined ? 'dms-core 3.6' : o.firmware };
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const subs: string[] = [];
  const failing = { stops: 0 };
  const deps: ReaimDeps = {
    link: {
      command: async (op, arg = 0, opts = {}) => {
        sent.push(`${op}:${arg}${opts.withResponse === false ? ':nr' : ''}`);
        if (op === COMMAND.AIM && arg === 0 && failing.stops > 0) {
          failing.stops -= 1;
          return false;
        }
        return true;
      },
      onViewFrames: (fn) => {
        viewFn = fn;
        return () => {
          viewFn = null;
        };
      },
      snapshot: () => snap as unknown as LinkSnapshot,
    },
    transport: () => ({
      subscribePairedView: async (fn) => {
        subs.push('sub');
        recordFn = fn;
      },
      unsubscribePairedView: async () => {
        subs.push('unsub');
        recordFn = null;
      },
    }),
    now: () => t,
    setTimer: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: t + ms, fn });
      return seq;
    },
    clearTimer: (h) => void timers.delete(h as number),
  };
  const flow = createReaimFlow(deps);
  const phases: ReaimPhase[] = [];
  flow.onPhase((p) => phases.push(p));
  const images: Uint8Array[] = [];
  flow.onViewFrame((j) => images.push(j));
  const aims: (AimFrame | null)[] = [];
  flow.onAim((a) => aims.push(a));
  return {
    flow,
    sent,
    subs,
    phases,
    images,
    aims,
    snap,
    failing,
    view: (f: AimFrame | ViewStateFrame) => viewFn?.(f),
    rec: (r: number[]) => recordFn?.(r),
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

const VIEW_ON: ViewStateFrame = { type: 'VIEW_STATE', on: 1, reason: 0, leftS: 600 };
const AIM: AimFrame = { type: 'AIM', seq: 1, score: 93, hint: 0, flags: 7, iod: 52, yaw: -3, pitch: 2 };

test('start: VIEW subscribed, then COMMAND 10 arg 1; the first image makes it live; images are acknowledged without response', async () => {
  const r = rig();
  await r.flow.start();
  expect(r.subs).toEqual(['sub']);
  expect(r.sent).toEqual([`${COMMAND.AIM}:1`]);
  expect(r.flow.phase().status).toBe('starting');
  r.view(VIEW_ON);
  r.rec(record(1, JPEG));
  r.view(AIM);
  await r.advance(250);
  expect(r.flow.phase().status).toBe('live');
  expect(r.images.map((i) => Array.from(i))).toEqual([JPEG]);
  expect(r.aims).toEqual([AIM]);
  expect(r.sent).toContain(`${COMMAND.VIEW_ACK}:1:nr`);
  expect(r.flow.streamed()).toBe(true);
});

test('no image: stalled after 4 s (start again), again every 3 s, and given up as the camera after 15 s stalled', async () => {
  const r = rig();
  await r.flow.start();
  r.view(VIEW_ON);
  await r.advance(REAIM_FIRST_MS);
  expect(r.flow.phase().status).toBe('stalled');
  expect(r.sent.filter((c) => c === `${COMMAND.AIM}:1`)).toHaveLength(2);
  await r.advance(REAIM_STALL_MS);
  expect(r.sent.filter((c) => c === `${COMMAND.AIM}:1`)).toHaveLength(3);
  await r.advance(REAIM_GIVE_UP_MS);
  expect(r.flow.phase()).toMatchObject({ status: 'refused', reason: 'camera' });
  expect(r.sent.at(-1)).toBe(`${COMMAND.AIM}:0`);
  expect(r.subs.at(-1)).toBe('unsub');
});

test('a refusal: refused with its reason, the picture listener gone; Try again starts it once more', async () => {
  const r = rig();
  await r.flow.start();
  r.view({ type: 'VIEW_STATE', on: 0, reason: 2, leftS: 600 });
  await r.advance(250);
  expect(r.flow.phase()).toMatchObject({ status: 'refused', reason: 'moving' });
  expect(r.subs.at(-1)).toBe('unsub');
  await r.flow.start();
  expect(r.flow.phase().status).toBe('starting');
  expect(r.sent.filter((c) => c === `${COMMAND.AIM}:1`)).toHaveLength(2);
});

test('Done after a picture: COMMAND 10 arg 0 and VIEW off, never COMMAND 2 (DashPal recalibrates at the stop); the images stop', async () => {
  const r = rig();
  await r.flow.start();
  r.view(VIEW_ON);
  r.rec(record(1, JPEG));
  await r.advance(250);
  await r.flow.close();
  expect(r.sent.at(-1)).toBe(`${COMMAND.AIM}:0`);
  expect(r.sent).not.toContain(`${COMMAND.RECALIBRATE}:0`);
  expect(r.subs.at(-1)).toBe('unsub');
  expect(r.aims.at(-1)).toBeNull();
  r.rec(record(2, JPEG));
  expect(r.images).toHaveLength(1);
  await r.flow.start();                                                         // closed: nothing more
  expect(r.sent.filter((c) => c === `${COMMAND.AIM}:1`)).toHaveLength(1);
});

test('Done with no picture ever (refused): COMMAND 2, so Recalibrate still recalibrates', async () => {
  const r = rig();
  await r.flow.start();
  r.view({ type: 'VIEW_STATE', on: 0, reason: 3, leftS: 600 });
  await r.advance(250);
  await r.flow.close();
  expect(r.sent.at(-1)).toBe(`${COMMAND.RECALIBRATE}:0`);
});

test('firmware before 3.6: unsupported, no picture asked; Done recalibrates', async () => {
  const r = rig({ firmware: 'dms-core 3.5' });
  await r.flow.start();
  expect(r.flow.phase().status).toBe('unsupported');
  expect(r.sent).toEqual([]);
  expect(r.subs).toEqual([]);
  await r.flow.close();
  expect(r.sent).toEqual([`${COMMAND.RECALIBRATE}:0`]);
});

test('not connected: offline, nothing sent, Done sends nothing', async () => {
  const r = rig({ lifecycle: 'idle' });
  await r.flow.start();
  expect(r.flow.phase().status).toBe('offline');
  await r.advance(1000);
  await r.flow.close();
  expect(r.sent).toEqual([]);
  r.snap.lifecycle = 'connected';
  await r.advance(1000);                                                        // closed: it never starts
  expect(r.sent).toEqual([]);
});

test('opened with no link: the picture starts on its own once DashPal connects', async () => {
  const r = rig({ lifecycle: 'idle' });
  await r.flow.start();
  await r.advance(750);
  expect(r.flow.phase().status).toBe('offline');
  expect(r.sent).toEqual([]);
  r.snap.lifecycle = 'connected';
  await r.advance(250);
  expect(r.flow.phase().status).toBe('starting');
  expect(r.subs).toEqual(['sub']);
  expect(r.sent).toEqual([`${COMMAND.AIM}:1`]);
});

test('Done when the stop fails: once more, and COMMAND 2 when it never went through', async () => {
  for (const [fails, recal] of [[1, false], [2, true]] as const) {
    const r = rig();
    await r.flow.start();
    r.view(VIEW_ON);
    r.rec(record(1, JPEG));
    await r.advance(250);
    r.failing.stops = fails;
    await r.flow.close();
    expect(r.sent.filter((c) => c === `${COMMAND.AIM}:0`)).toHaveLength(2);
    expect(r.sent.includes(`${COMMAND.RECALIBRATE}:0`)).toBe(recal);
    expect(r.subs.at(-1)).toBe('unsub');
  }
});

test('the link going down while live: offline, the picture dropped; RoadWise leaving the front stops it and coming back starts it', async () => {
  const r = rig();
  await r.flow.start();
  r.view(VIEW_ON);
  r.rec(record(1, JPEG));
  await r.advance(250);
  r.flow.setAppActive(false);
  await flush();
  expect(r.sent.at(-1)).toBe(`${COMMAND.AIM}:0`);
  expect(r.flow.phase().status).toBe('starting');
  r.flow.setAppActive(true);
  await flush();
  expect(r.sent.at(-1)).toBe(`${COMMAND.AIM}:1`);
  r.snap.lifecycle = 'idle';
  await r.advance(250);
  expect(r.flow.phase().status).toBe('offline');
  expect(r.aims.at(-1)).toBeNull();
  r.snap.lifecycle = 'connected';                                               // back: the picture again
  await r.advance(250);
  expect(r.flow.phase().status).toBe('starting');
  expect(r.sent.at(-1)).toBe(`${COMMAND.AIM}:1`);
});

test('supportsReaim reads the DIS / INFO firmware', () => {
  expect(supportsReaim('dms-core 3.6')).toBe(true);
  expect(supportsReaim('dms-core 3.10')).toBe(true);
  expect(supportsReaim('dms-core 4.0')).toBe(true);
  expect(supportsReaim('dms-core 3.5')).toBe(false);
  expect(supportsReaim(null)).toBeNull();
  expect(supportsReaim('garbage')).toBeNull();
});

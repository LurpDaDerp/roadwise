// DashPal alerts with the app in the Android background during a drive: JS timers are paused there
// (React Native's JavaTimerManager, no headless task); the drive's rows and the dashcam's frames are
// the only things that reach JS. The real link, the real alert player and the real expo ports run
// over a timer base that never fires while paused; a row is the host's pump plus `link.row`.
import { Platform as mockPlatform, Vibration } from 'react-native';

import { flushMicrotasks, nativeAudio } from '@/core/alerts/__fixtures__/expoNative';
import { ANDROID_VIBRATION, createExpoAlertPorts } from '@/core/alerts/adapters';
import { createAlertPlayer } from '@/core/alerts/player';
import type { AlertDecision } from '@/core/alerts/types';
import type { FeatureRow } from '@/core/engine/types';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { migrate } from '@/data/db';
import { createPausableTimerBase, type PausableTimerBase } from '@/lib/__fixtures__/pausableTimers';
import { createPumpedTimers, type PumpedTimers } from '@/lib/timers';

import type { PairedDashcam } from '../keys';
import { createDashcamLink, type DashcamLink, type LinkContext } from '../link';
import { decodeInfo, decodeRx, encodeInfo, encodeTx, SOUND, STATE_TTL_DS, STATUS_FLAG, type RxFrame, type TxFrame } from '../protocol';
import { createDashcamStore } from '../store';

jest.mock('expo-audio', () => jest.requireActual('@/core/alerts/__fixtures__/expoNative').expoAudioMock());
jest.mock('expo-speech', () => jest.requireActual('@/core/alerts/__fixtures__/expoNative').expoSpeechMock());

const T0 = 1_791_600_000_000;
const UP = 3_600_000;
const CAM = 'a4cf12b3c4d5';
const PAIRED: PairedDashcam = { dashcamId: CAM, peripheralId: 'periph-1', name: 'DashPal-C4D5', pairedAt: T0 - 1 };
const TRIP = '11111111-1111-4111-8111-111111111111';
const INFO = decodeInfo(
  encodeInfo({ ver: 1, protoMin: 1, protoMax: 1, fwMajor: 3, fwMinor: 3, mac: [0xa4, 0xcf, 0x12, 0xb3, 0xc4, 0xd5], peerBonded: true, bondCount: 1, pairingOpen: false })
)!;

interface Rig {
  base: PausableTimerBase;
  timers: PumpedTimers;
  link: DashcamLink;
  ctx: LinkContext;
  writes: { frame: RxFrame; urgent: boolean; at: number }[];
  tones: { level: number; tone: string | null; at: number }[];
  vibrations: { pattern: number[]; at: number }[];
  deliver(d: AlertDecision): Promise<void>;
  now(): number;
  uptime(): number;
  rx(f: TxFrame): void;
  /** Time passes; nothing fires while paused. */
  advance(ms: number): void;
  /** A drive row: the host pumps the timers, then the dashcam hook ticks the link. */
  row(): void;
}

let restoreOS: (() => void) | null = null;

beforeEach(() => {
  nativeAudio.reset();
  restoreOS = jest.replaceProperty(mockPlatform, 'OS', 'android').restore;
});

afterEach(() => {
  restoreOS?.();
  restoreOS = null;
  jest.restoreAllMocks();
});

function featureRow(ts: number): FeatureRow {
  return {
    ts,
    lat: 40,
    lng: -75,
    hAcc: 5,
    speed: 20,
    speedAcc: 0.5,
    course: 0,
    alt: 0,
    gnssValid: true,
    aLonMax: 0,
    aLonMin: 0,
    aLatMax: 0,
    aLatMin: 0,
    yawRateMax: 0,
    jerkMax: 0,
    gravityStability: 1,
    orientationDelta: 0,
    handlingScore: 0,
    locked: true,
    screenOn: false,
    appForeground: false,
  };
}

async function rig(): Promise<Rig> {
  const db = await createSqlJsDb();
  await migrate(db);
  const base = createPausableTimerBase(T0);
  const timers = createPumpedTimers(base);
  const writes: Rig['writes'] = [];
  const tones: Rig['tones'] = [];
  const vibrations: Rig['vibrations'] = [];
  jest.spyOn(Vibration, 'vibrate').mockImplementation((p) => {
    vibrations.push({ pattern: [...(p as number[])], at: base.now() });
  });
  jest.spyOn(Vibration, 'cancel').mockImplementation(() => {});
  const ports = await createExpoAlertPorts({ timers, timersPaused: () => base.paused() });
  const player = createAlertPlayer({
    ...ports,
    audio: {
      ...ports.audio,
      play: (level, opts) => {
        tones.push({ level, tone: opts.tone ?? null, at: base.now() });
        return ports.audio.play(level, opts);
      },
    },
    timers,
    voiceEnabled: () => false,
    callActive: () => false,
    l1RespectsSilentSwitch: () => false,
  });
  const ctx: LinkContext = { recording: true, driveOpen: true, foreground: true, playerAvailable: true, styleAllowsSound: true, callActive: false, buzzerToo: false };
  let n = 0;
  let wakeTimer: unknown = null;
  const link: DashcamLink = createDashcamLink({
    now: base.now,
    store: createDashcamStore(db),
    newId: () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`,
    write: async (bytes, o) => {
      const d = decodeRx(bytes);
      if (!d.ok) throw new Error(`bad rx frame ${d.reason}`);
      writes.push({ frame: d.frame, urgent: o.urgent === true, at: base.now() });
    },
    player,
    context: () => ctx,
    localMinute: () => 615,
    // As the runtime wires it: one pumped wake timer, a pumped sleep.
    wake: (at) => {
      if (wakeTimer !== null) timers.clearTimeout(wakeTimer);
      wakeTimer = null;
      if (at === null) return;
      wakeTimer = timers.setTimeout(() => {
        wakeTimer = null;
        link.tick();
      }, Math.max(0, at - base.now()));
    },
    delay: (ms) => timers.sleep(ms),
    timersPaused: () => base.paused(),
  });
  link.setPaired(PAIRED);
  link.setBluetooth('on');
  const r: Rig = {
    base,
    timers,
    link,
    ctx,
    writes,
    tones,
    vibrations,
    deliver: (d) => player.deliver(d),
    now: base.now,
    uptime: () => base.now() - T0 + UP,
    rx: (f) => link.frame(encodeTx(f)),
    advance: (ms) => base.advance(ms),
    row: () => {
      timers.pump();
      link.row(featureRow(base.now()), { clientTripId: TRIP, recording: true, dryRun: false });
    },
  };
  return r;
}

const settle = async (r: Rig) => {
  await r.link.settled();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await r.link.settled();
  await flushMicrotasks();
};

/** In the foreground (timers running): link up, HELLO, three echoes, RESUME. */
async function connect(r: Rig): Promise<void> {
  expect(r.link.infoRead(INFO)).toBe(true);
  r.link.linkUp(INFO);
  r.advance(30);
  r.rx({ type: 'HELLO', bootId: 0xdeadbeef, nextSeq: 0, oldestSeq: 0, uptimeMs: r.uptime() });
  await settle(r);
  for (let i = 0; i < 3; i++) {
    const ping = r.writes.filter((w) => w.frame.type === 'TIME_PING').at(-1)!.frame as Extract<RxFrame, { type: 'TIME_PING' }>;
    r.advance(5);
    r.rx({ type: 'TIME_ECHO', reqId: ping.reqId, uptimeMs: r.uptime() });
    r.advance(100);
  }
  await settle(r);
  r.link.tick();
  expect(r.writes.some((w) => w.frame.type === 'RESUME')).toBe(true);
}

/** The app goes to the background mid-drive: JS timers pause. */
function background(r: Rig): void {
  r.ctx.foreground = false;
  r.base.pause(true);
}

const brake = (id: string, at: number): AlertDecision => ({ id, level: 2, kind: 'hard_brake', ts: at, intensity: 3 });

const alertAcks = (r: Rig) => r.writes.filter((w) => w.frame.type === 'ALERT_ACK');

describe('DashPal alerts with JS timers paused (Android, app in the background, drive open)', () => {
  it('a routed alert 5 s after a phone alert is ACKed at once, as the frame arrives, and plays', async () => {
    const r = await rig();
    await connect(r);
    background(r);
    await r.deliver(brake('a', r.now()));
    r.advance(5000);
    r.rx({ type: 'ALERT', alertId: 7, sound: SOUND.GLANCE, tier: 2, level: 0, mode: 0, route: 1, uptimeMs: r.uptime() });
    // Synchronously, before any promise or timer: the dashcam's 750 ms deadline needs no JS timer.
    expect(alertAcks(r).map((w) => ({ ...w.frame, urgent: w.urgent, at: w.at }))).toEqual([{ type: 'ALERT_ACK', alertId: 7, outcome: 1, urgent: true, at: r.now() }]);
    await flushMicrotasks();
    expect(r.tones.map((t) => t.tone)).toEqual([null, 'dp_glance']);
    expect(r.vibrations.map((v) => v.pattern)).toEqual([[...ANDROID_VIBRATION[3]], [...ANDROID_VIBRATION[2]]]);
  });

  it('a routed alert arriving while the phone alert still holds the player is ACKed at once and plays after it, by the next row at worst', async () => {
    const r = await rig();
    await connect(r);
    background(r);
    nativeAudio.next.push('loadedOnly'); // the phone tone never reports its finish
    void r.deliver(brake('a', r.now()));
    await flushMicrotasks();
    r.advance(200);
    r.rx({ type: 'ALERT', alertId: 8, sound: SOUND.GLANCE, tier: 2, level: 0, mode: 0, route: 1, uptimeMs: r.uptime() });
    expect(alertAcks(r).map((w) => w.frame)).toEqual([{ type: 'ALERT_ACK', alertId: 8, outcome: 1 }]);
    await flushMicrotasks();
    expect(r.tones.map((t) => t.tone)).toEqual([null]);
    r.advance(2000); // past the tone's fallback; paused, nothing fires
    await flushMicrotasks();
    expect(r.tones).toHaveLength(1);
    r.row();
    await flushMicrotasks();
    expect(r.tones.map((t) => t.tone)).toEqual([null, 'dp_glance']);
    expect(alertAcks(r)).toHaveLength(1); // no ACK(0): the phone kept it
  });

  it('a continuous alert keeps repeating on row ticks, the lease renewed on every row, with no JS timer firing', async () => {
    const r = await rig();
    await connect(r);
    background(r);
    r.rx({ type: 'ALERT', alertId: 9, sound: SOUND.GLANCE, tier: 2, level: 0, mode: 1, route: 1, uptimeMs: r.uptime() });
    await flushMicrotasks();
    const start = r.now();
    const statesBefore = r.writes.filter((w) => w.frame.type === 'STATE').length;
    for (let s = 0; s < 12; s++) {
      r.advance(1000);
      // The dashcam sends STATUS every second while an alert is active (the link stays fresh).
      r.rx({ type: 'STATUS', uptimeMs: r.uptime(), state: 3, flags: STATUS_FLAG.LIVE, fpsX10: 150, tempC: 40, bondCount: 1 });
      r.row();
      await flushMicrotasks();
    }
    const plays = r.tones.filter((t) => t.tone === 'dp_glance').map((t) => t.at - start);
    expect(plays).toEqual([0, 3000, 6000, 9000, 12000]); // 2.5 s cadence, rounded up to the next row
    expect(r.vibrations).toHaveLength(plays.length);
    expect(alertAcks(r).map((w) => w.frame)).toEqual([{ type: 'ALERT_ACK', alertId: 9, outcome: 1 }]);
    const states = r.writes.filter((w) => w.frame.type === 'STATE').slice(statesBefore);
    expect(states.length).toBeGreaterThanOrEqual(12);
    const gaps = states.slice(1).map((w, i) => w.at - states[i]!.at);
    expect(Math.max(...gaps)).toBeLessThan(STATE_TTL_DS * 100);
  });
});

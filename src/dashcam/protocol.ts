// The DashPal BLE protocol v1 codec (plan §3.1–3.2; the authoritative copy is the firmware's
// `docs/BLE_PROTOCOL.md`, repeated in ./PROTOCOL.md). Pure: bytes in, typed frames out, and back.
//
// Rules every decoder here follows:
// - little-endian; byte 0 = type, byte 1 = protocol version (1);
// - a frame at least as long as its v1 length is accepted and trailing bytes are ignored (a later
//   version may append fields; the 20-byte sender maximum is not enforced on receipt);
// - everything else is refused with a reason, never thrown, checked in this order: length < 2
//   `short`; not a type of this direction `type`; version ≠ 1 `version`; shorter than the type's v1
//   length `short` (the firmware's codec checks the same, in the same order);
// - a sender never sends more than 20 bytes, so every frame fits the default ATT MTU.
//
// Values cross the BLE bridge as `number[]` (react-native-ble-manager), so encoders return one.

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 20;

/** `d5a1xxxx-7b3e-4c8a-9f21-0c6e5a7d2b10`, lowercase (both platforms report lowercase). */
export const dashpalUuid = (short: string): string => `d5a1${short}-7b3e-4c8a-9f21-0c6e5a7d2b10`;

/** Advertised while the pairing window is closed; holds the four characteristics. */
export const DASHPAL_SERVICE = dashpalUuid('0001');
/** An empty service advertised instead of the DashPal one while the pairing window is open. */
export const PAIRING_SERVICE = dashpalUuid('00f0');
export const INFO_CHAR = dashpalUuid('0002');
export const IDENTIFY_CHAR = dashpalUuid('0003');
export const TX_CHAR = dashpalUuid('0004');
export const RX_CHAR = dashpalUuid('0005');

/** The IDENTIFY characteristic's one command byte. */
export const IDENTIFY_BYTE = 0x01;

// ——— frame types ———

export const TX_TYPE = {
  HELLO: 0x01,
  STATUS: 0x02,
  EVENT: 0x03,
  ALERT: 0x04,
  ALERT_STOP: 0x05,
  ALERT_FALLBACK: 0x06,
  TIME_ECHO: 0x07,
  PAIRED: 0x08,
} as const;

export const RX_TYPE = {
  STATE: 0x81,
  ACK: 0x82,
  ALERT_ACK: 0x83,
  TIME_PING: 0x84,
  RESUME: 0x85,
  COMMAND: 0x86,
} as const;

/** The v1 length of each dashcam → phone frame type, header included. */
export const TX_LEN: Readonly<Record<number, number>> = {
  [TX_TYPE.HELLO]: 18,
  [TX_TYPE.STATUS]: 11,
  [TX_TYPE.EVENT]: 18,
  [TX_TYPE.ALERT]: 14,
  [TX_TYPE.ALERT_STOP]: 5,
  [TX_TYPE.ALERT_FALLBACK]: 5,
  [TX_TYPE.TIME_ECHO]: 8,
  [TX_TYPE.PAIRED]: 3,
};

/** The v1 length of each phone → dashcam frame type, header included. */
export const RX_LEN: Readonly<Record<number, number>> = {
  [RX_TYPE.STATE]: 16,
  [RX_TYPE.ACK]: 10,
  [RX_TYPE.ALERT_ACK]: 5,
  [RX_TYPE.TIME_PING]: 12,
  [RX_TYPE.RESUME]: 10,
  [RX_TYPE.COMMAND]: 4,
};

export const INFO_LEN = 14;
export const INFO_VERSION = 1;
/** INFO `flags` bits. */
export const INFO_FLAG = { PAIRING_OPEN: 0x01, SETUP_BUSY: 0x02 } as const;

/** Engine event ids, in the frozen `dms/alerts.py` `EventType` order. Append-only. */
export const EVENT_NAMES: readonly string[] = [
  'MICROSLEEP',
  'SLEEP',
  'UNRESPONSIVE',
  'LONG_GLANCE',
  'VATS',
  'FACE_LOST',
  'FATIGUE_DROWSY',
  'FATIGUE_SEVERE',
  'FATIGUE_EARLY',
  'PHONE_PATTERN',
  'REPEATED_DISTRACTION',
  'MONITORING_LIMITED',
  'GLANCE',
  'LOOK_BACK',
  'YAWN',
  'HEAD_NOD',
  'REPEAT_MICROSLEEP',
  'GAZE_CONCENTRATION',
  'NO_SCANNING',
  'FATIGUE_LEVEL',
  'CALIBRATED',
  'CALIBRATION_LOW_CONFIDENCE',
  'CALIBRATION_RESET',
  'CAMERA_BUMP',
  'DRIVER_CHANGE',
  'RECENTRED',
  'POSTURE_CHANGE',
  'ZONE_LEARNED',
  'NUISANCE_TAG',
  'MONITORING_RESTORED',
  'PHONE_HANDHELD',
  'CRITICAL_STAND_DOWN',
];

export const EV = { MICROSLEEP: 0, SLEEP: 1, UNRESPONSIVE: 2, CRITICAL_STAND_DOWN: 31 } as const;

/** `UNKNOWN_<n>` for an id this app does not know: stored, never scored. */
export const eventName = (ev: number): string => EVENT_NAMES[ev] ?? `UNKNOWN_${ev}`;

/**
 * EVENT `detail` values. UNRESPONSIVE: no_return (D4), eyes_closed, no_return_critical (F3);
 * MICROSLEEP: nod; CRITICAL_STAND_DOWN: face_gone (log only: a critical stopped because the driver
 * left the car; stored, never scored, never an episode).
 */
export const DETAIL = { NONE: 0, NO_RETURN: 1, EYES_CLOSED: 2, NO_RETURN_CRITICAL: 3, NOD: 4, FACE_GONE: 5 } as const;

/** STATUS `state`. */
export const DASHCAM_STATE = {
  BOOTING: 0,
  NO_FACE: 1,
  CALIBRATING: 2,
  MONITORING: 3,
  LIMITED: 4,
  PAUSED: 5,
  CAMERA_ERROR: 6,
} as const;

/** STATUS `flags` bits. */
export const STATUS_FLAG = {
  MUTED: 1 << 0,
  PAIRING_OPEN: 1 << 1,
  TIME_SYNCED: 1 << 2,
  CALIBRATED: 1 << 3,
  PRIMARY: 1 << 4,
  BUZZER_ACTIVE: 1 << 5,
  LIVE: 1 << 6,
} as const;

/**
 * ALERT `sound`. NO_FACE (6): the driver's face out of view while the phone reports the car moving;
 * continuous, tier 2, never joined by the buzzer, silent on both outputs while no phone is live.
 * COMMAND 6 (test sound) takes 1–5 only.
 */
export const SOUND = { GLANCE: 1, DROWSY: 2, WAKE: 3, PHONE: 4, CHIME: 5, NO_FACE: 6 } as const;
export type AlertSound = 1 | 2 | 3 | 4 | 5 | 6;

/** ALERT_STOP `reason`. */
export const STOP_REASON = { CLEARED: 0, SUPERSEDED: 1, MUTED: 2 } as const;
/** ALERT_FALLBACK `cause`. */
export const FALLBACK_CAUSE = { NO_ACK: 1, CANNOT: 2, LEASE: 3, ESCALATION: 4 } as const;

/** STATE `flags` bits. */
export const STATE_FLAG = { CAN_PLAY: 1 << 0, BUZZER_TOO: 1 << 1, DRIVE_ACTIVE: 1 << 2, SPEED_VALID: 1 << 3 } as const;

/** COMMAND `op`. */
export const COMMAND = {
  IDENTIFY: 1,
  RECALIBRATE: 2,
  OPEN_PAIRING: 3,
  FORGET_ME: 4,
  PAIR_CONFIRM: 5,
  TEST_SOUND: 6,
  HELLO: 7,
} as const;

/** ALERT_ACK `outcome`. */
export const ACK_OUTCOME = { CANNOT: 0, PLAYING: 1 } as const;

/** STATE `local_min` when the phone does not know the local time. */
export const LOCAL_MIN_UNKNOWN = 0xffff;
/** The lease lifetime the phone asks for, in 0.1 s. */
export const STATE_TTL_DS = 30;

// ——— decoded shapes ———

export interface Hello {
  type: 'HELLO';
  bootId: number;
  nextSeq: number;
  oldestSeq: number;
  uptimeMs: number;
}

export interface Status {
  type: 'STATUS';
  uptimeMs: number;
  state: number;
  flags: number;
  /** frames per second × 10 */
  fpsX10: number;
  tempC: number;
  bondCount: number;
}

export interface DashcamEventFrame {
  type: 'EVENT';
  seq: number;
  tMs: number;
  durDs: number;
  ev: number;
  tier: number;
  audible: boolean;
  detail: number;
  valueX10: number;
}

export interface AlertFrame {
  type: 'ALERT';
  alertId: number;
  sound: number;
  tier: number;
  level: number;
  /** 0 once, 1 continuous */
  mode: number;
  /** 1 routed to this phone (ACK required), 0 informational */
  route: number;
  uptimeMs: number;
}

export interface AlertStop {
  type: 'ALERT_STOP';
  alertId: number;
  reason: number;
}

export interface AlertFallback {
  type: 'ALERT_FALLBACK';
  alertId: number;
  cause: number;
}

export interface TimeEcho {
  type: 'TIME_ECHO';
  reqId: number;
  uptimeMs: number;
}

export interface Paired {
  type: 'PAIRED';
  bondCount: number;
}

export type TxFrame = Hello | Status | DashcamEventFrame | AlertFrame | AlertStop | AlertFallback | TimeEcho | Paired;

export interface StateFrame {
  type: 'STATE';
  flags: number;
  ttlDs: number;
  speedCms: number;
  localMin: number;
  bootId: number;
  ackSeq: number;
}

export interface AckFrame {
  type: 'ACK';
  bootId: number;
  ackSeq: number;
}

export interface AlertAckFrame {
  type: 'ALERT_ACK';
  alertId: number;
  outcome: number;
}

export interface TimePing {
  type: 'TIME_PING';
  reqId: number;
  epochMs: number;
}

export interface Resume {
  type: 'RESUME';
  bootId: number;
  nextSeq: number;
}

export interface Command {
  type: 'COMMAND';
  op: number;
  arg: number;
}

export type RxFrame = StateFrame | AckFrame | AlertAckFrame | TimePing | Resume | Command;

export interface DashcamInfo {
  ver: number;
  protoMin: number;
  protoMax: number;
  fwMajor: number;
  fwMinor: number;
  /** identity MAC, MSB first, 6 bytes */
  mac: number[];
  /** lowercase hex of the MAC, 12 chars: the phone's `dashcam_id` */
  dashcamId: string;
  /** `DashPal-XXXX`: the last two MAC bytes, uppercase hex */
  name: string;
  /** this link's peer is in the dashcam's bond store */
  peerBonded: boolean;
  bondCount: number;
  /** INFO flags bit 0: the pairing window is open */
  pairingOpen: boolean;
  /** INFO flags bit 1: another link holds the setup claim (another phone is setting this dashcam up) */
  setupBusy: boolean;
}

/** Why a frame was refused (the firmware's names). */
export type BadReason = 'short' | 'type' | 'version';

export type Decoded<T> = { ok: true; frame: T } | { ok: false; reason: BadReason };

// ——— byte helpers ———

const u8 = (b: ArrayLike<number>, i: number): number => (b[i] ?? 0) & 0xff;
const u16 = (b: ArrayLike<number>, i: number): number => u8(b, i) | (u8(b, i + 1) << 8);
const i16 = (b: ArrayLike<number>, i: number): number => {
  const v = u16(b, i);
  return v >= 0x8000 ? v - 0x10000 : v;
};
const i8 = (b: ArrayLike<number>, i: number): number => {
  const v = u8(b, i);
  return v >= 0x80 ? v - 0x100 : v;
};
// `>>> 0` keeps a u32 unsigned (JS bit operators are signed 32-bit).
const u32 = (b: ArrayLike<number>, i: number): number =>
  (u8(b, i) | (u8(b, i + 1) << 8) | (u8(b, i + 2) << 16) | (u8(b, i + 3) << 24)) >>> 0;

/** A whole number clamped into [lo, hi]; NaN becomes lo. */
function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

class Writer {
  readonly bytes: number[] = [];
  u8(v: number): this {
    this.bytes.push(clampInt(v, 0, 0xff));
    return this;
  }
  u16(v: number): this {
    const x = clampInt(v, 0, 0xffff);
    this.bytes.push(x & 0xff, (x >>> 8) & 0xff);
    return this;
  }
  u32(v: number): this {
    const x = clampInt(v, 0, 0xffffffff);
    this.bytes.push(x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, Math.floor(x / 0x1000000) & 0xff);
    return this;
  }
  i8(v: number): this {
    return this.u8((clampInt(v, -128, 127) + 0x100) & 0xff);
  }
  i16(v: number): this {
    return this.u16((clampInt(v, -32768, 32767) + 0x10000) & 0xffff);
  }
  /** An unsigned 64-bit integer from a non-negative safe integer (epoch ms). */
  u64(v: number): this {
    const x = clampInt(v, 0, Number.MAX_SAFE_INTEGER);
    const lo = x % 0x100000000;
    const hi = Math.floor(x / 0x100000000);
    return this.u32(lo).u32(hi);
  }
}

const header = (type: number): Writer => new Writer().u8(type).u8(PROTOCOL_VERSION);

/** The header checks, in the order the firmware applies them, for one direction's types. */
function check(bytes: ArrayLike<number>, lengths: Readonly<Record<number, number>>): { ok: true; type: number } | { ok: false; reason: BadReason } {
  if (bytes.length < 2) return { ok: false, reason: 'short' };
  const type = u8(bytes, 0);
  const len = lengths[type];
  if (len === undefined) return { ok: false, reason: 'type' };
  if (u8(bytes, 1) !== PROTOCOL_VERSION) return { ok: false, reason: 'version' };
  if (bytes.length < len) return { ok: false, reason: 'short' };
  return { ok: true, type };
}

// ——— dashcam → phone ———

/** Decode one TX notification. Never throws. */
export function decodeTx(bytes: ArrayLike<number>): Decoded<TxFrame> {
  const head = check(bytes, TX_LEN);
  if (!head.ok) return head;
  const b = bytes;
  switch (head.type) {
    case TX_TYPE.HELLO:
      return { ok: true, frame: { type: 'HELLO', bootId: u32(b, 2), nextSeq: u32(b, 6), oldestSeq: u32(b, 10), uptimeMs: u32(b, 14) } };
    case TX_TYPE.STATUS:
      return {
        ok: true,
        frame: { type: 'STATUS', uptimeMs: u32(b, 2), state: u8(b, 6), flags: u8(b, 7), fpsX10: u8(b, 8), tempC: i8(b, 9), bondCount: u8(b, 10) },
      };
    case TX_TYPE.EVENT: {
      const tierAud = u8(b, 13);
      return {
        ok: true,
        frame: {
          type: 'EVENT',
          seq: u32(b, 2),
          tMs: u32(b, 6),
          durDs: u16(b, 10),
          ev: u8(b, 12),
          tier: tierAud & 0x03,
          audible: (tierAud & 0x80) !== 0,
          detail: u8(b, 14),
          valueX10: i16(b, 15),
        },
      };
    }
    case TX_TYPE.ALERT:
      return {
        ok: true,
        frame: {
          type: 'ALERT',
          alertId: u16(b, 2),
          sound: u8(b, 4),
          tier: u8(b, 5),
          level: u8(b, 6),
          mode: u8(b, 7),
          route: u8(b, 8),
          uptimeMs: u32(b, 10),
        },
      };
    case TX_TYPE.ALERT_STOP:
      return { ok: true, frame: { type: 'ALERT_STOP', alertId: u16(b, 2), reason: u8(b, 4) } };
    case TX_TYPE.ALERT_FALLBACK:
      return { ok: true, frame: { type: 'ALERT_FALLBACK', alertId: u16(b, 2), cause: u8(b, 4) } };
    case TX_TYPE.TIME_ECHO:
      return { ok: true, frame: { type: 'TIME_ECHO', reqId: u16(b, 2), uptimeMs: u32(b, 4) } };
    case TX_TYPE.PAIRED:
      return { ok: true, frame: { type: 'PAIRED', bondCount: u8(b, 2) } };
    default:
      return { ok: false, reason: 'type' };
  }
}

/** Encode a dashcam → phone frame (tests, the simulator bridge and vectors). */
export function encodeTx(f: TxFrame): number[] {
  switch (f.type) {
    case 'HELLO':
      return header(TX_TYPE.HELLO).u32(f.bootId).u32(f.nextSeq).u32(f.oldestSeq).u32(f.uptimeMs).bytes;
    case 'STATUS':
      return header(TX_TYPE.STATUS).u32(f.uptimeMs).u8(f.state).u8(f.flags).u8(f.fpsX10).i8(f.tempC).u8(f.bondCount).bytes;
    case 'EVENT':
      return header(TX_TYPE.EVENT)
        .u32(f.seq)
        .u32(f.tMs)
        .u16(f.durDs)
        .u8(f.ev)
        .u8((f.tier & 0x03) | (f.audible ? 0x80 : 0))
        .u8(f.detail)
        .i16(f.valueX10)
        .u8(0).bytes;
    case 'ALERT':
      return header(TX_TYPE.ALERT).u16(f.alertId).u8(f.sound).u8(f.tier).u8(f.level).u8(f.mode).u8(f.route).u8(0).u32(f.uptimeMs).bytes;
    case 'ALERT_STOP':
      return header(TX_TYPE.ALERT_STOP).u16(f.alertId).u8(f.reason).bytes;
    case 'ALERT_FALLBACK':
      return header(TX_TYPE.ALERT_FALLBACK).u16(f.alertId).u8(f.cause).bytes;
    case 'TIME_ECHO':
      return header(TX_TYPE.TIME_ECHO).u16(f.reqId).u32(f.uptimeMs).bytes;
    case 'PAIRED':
      return header(TX_TYPE.PAIRED).u8(f.bondCount).bytes;
  }
}

// ——— phone → dashcam ———

export function encodeRx(f: RxFrame): number[] {
  switch (f.type) {
    case 'STATE':
      return header(RX_TYPE.STATE).u8(f.flags).u8(f.ttlDs).u16(f.speedCms).u16(f.localMin).u32(f.bootId).u32(f.ackSeq).bytes;
    case 'ACK':
      return header(RX_TYPE.ACK).u32(f.bootId).u32(f.ackSeq).bytes;
    case 'ALERT_ACK':
      return header(RX_TYPE.ALERT_ACK).u16(f.alertId).u8(f.outcome).bytes;
    case 'TIME_PING':
      return header(RX_TYPE.TIME_PING).u16(f.reqId).u64(f.epochMs).bytes;
    case 'RESUME':
      return header(RX_TYPE.RESUME).u32(f.bootId).u32(f.nextSeq).bytes;
    case 'COMMAND':
      return header(RX_TYPE.COMMAND).u8(f.op).u8(f.arg).bytes;
  }
}

/** Decode a phone → dashcam frame (tests and vectors; the firmware is the real reader). */
export function decodeRx(bytes: ArrayLike<number>): Decoded<RxFrame> {
  const head = check(bytes, RX_LEN);
  if (!head.ok) return head;
  const b = bytes;
  switch (head.type) {
    case RX_TYPE.STATE:
      return {
        ok: true,
        frame: { type: 'STATE', flags: u8(b, 2), ttlDs: u8(b, 3), speedCms: u16(b, 4), localMin: u16(b, 6), bootId: u32(b, 8), ackSeq: u32(b, 12) },
      };
    case RX_TYPE.ACK:
      return { ok: true, frame: { type: 'ACK', bootId: u32(b, 2), ackSeq: u32(b, 6) } };
    case RX_TYPE.ALERT_ACK:
      return { ok: true, frame: { type: 'ALERT_ACK', alertId: u16(b, 2), outcome: u8(b, 4) } };
    case RX_TYPE.TIME_PING:
      return { ok: true, frame: { type: 'TIME_PING', reqId: u16(b, 2), epochMs: u32(b, 4) + u32(b, 8) * 0x100000000 } };
    case RX_TYPE.RESUME:
      return { ok: true, frame: { type: 'RESUME', bootId: u32(b, 2), nextSeq: u32(b, 6) } };
    case RX_TYPE.COMMAND:
      return { ok: true, frame: { type: 'COMMAND', op: u8(b, 2), arg: u8(b, 3) } };
    default:
      return { ok: false, reason: 'type' };
  }
}

// ——— INFO ———

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

/** The INFO read: ≥ 14 bytes (trailing ignored), `ver` 1. Null for anything else. */
export function decodeInfo(bytes: ArrayLike<number>): DashcamInfo | null {
  if (bytes.length < INFO_LEN) return null;
  const ver = u8(bytes, 0);
  if (ver !== INFO_VERSION) return null;
  const mac = [5, 6, 7, 8, 9, 10].map((i) => u8(bytes, i));
  const dashcamId = mac.map(hex2).join('');
  return {
    ver,
    protoMin: u8(bytes, 1),
    protoMax: u8(bytes, 2),
    fwMajor: u8(bytes, 3),
    fwMinor: u8(bytes, 4),
    mac,
    dashcamId,
    name: `DashPal-${(hex2(mac[4] ?? 0) + hex2(mac[5] ?? 0)).toUpperCase()}`,
    peerBonded: u8(bytes, 11) !== 0,
    bondCount: u8(bytes, 12),
    pairingOpen: (u8(bytes, 13) & INFO_FLAG.PAIRING_OPEN) !== 0,
    setupBusy: (u8(bytes, 13) & INFO_FLAG.SETUP_BUSY) !== 0,
  };
}

/** The INFO bytes (the dashcam's side; tests and the e2e bench). `setupBusy` defaults to false. */
export function encodeInfo(info: Omit<DashcamInfo, 'dashcamId' | 'name' | 'setupBusy'> & { setupBusy?: boolean }): number[] {
  const w = new Writer().u8(info.ver).u8(info.protoMin).u8(info.protoMax).u8(info.fwMajor).u8(info.fwMinor);
  for (let i = 0; i < 6; i++) w.u8(info.mac[i] ?? 0);
  const flags = (info.pairingOpen ? INFO_FLAG.PAIRING_OPEN : 0) | (info.setupBusy ? INFO_FLAG.SETUP_BUSY : 0);
  return w.u8(info.peerBonded ? 1 : 0).u8(info.bondCount).u8(flags).bytes;
}

/** This app speaks protocol v1: the dashcam must accept it. */
export const speaksV1 = (info: DashcamInfo): boolean => info.protoMin <= PROTOCOL_VERSION && PROTOCOL_VERSION <= info.protoMax;

/** A lowercase 12-hex-char dashcam id. */
export const isDashcamId = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{12}$/.test(s);

export const toHex = (bytes: ArrayLike<number>): string => Array.from(bytes, (b) => hex2(b & 0xff)).join('');
export function fromHex(hex: string): number[] {
  const clean = hex.replace(/\s+/g, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

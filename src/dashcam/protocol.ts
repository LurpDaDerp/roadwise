// The DashPal BLE frame codec (the authoritative copy is the firmware's `docs/BLE_PROTOCOL.md`,
// repeated in ./PROTOCOL.md). Pure: bytes in, typed frames out, and back. The link is v3 (INFO
// `proto` 3): every frame travels sealed (./auth.ts) and the frame inside keeps version byte 1.
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
/** The link version this app speaks (INFO `proto_min`..`proto_max` must include it). */
export const LINK_VERSION = 3;
/** The smallest ATT MTU a session works on (a 40-byte sealed notification needs 43). */
export const SEAL_MIN_MTU = 43;

/** `d5a1xxxx-7b3e-4c8a-9f21-0c6e5a7d2b10`, lowercase (both platforms report lowercase). */
export const dashpalUuid = (short: string): string => `d5a1${short}-7b3e-4c8a-9f21-0c6e5a7d2b10`;

/** Advertised while the pairing window is closed and no setup is live; holds the six characteristics. */
export const DASHPAL_SERVICE = dashpalUuid('0001');
/**
 * Empty services advertised instead of it: the window open with no phone paired ("new"), a setup
 * claim or hold live ("setup"), the window open with phones paired ("open").
 */
export const PAIRING_NEW = dashpalUuid('00f0');
export const PAIRING_SETUP = dashpalUuid('00f1');
export const PAIRING_OPEN = dashpalUuid('00f2');
export const INFO_CHAR = dashpalUuid('0002');
/** Kept so the later handles never move; the dashcam refuses every write to it. */
export const IDENTIFY_CHAR = dashpalUuid('0003');
export const TX_CHAR = dashpalUuid('0004');
export const RX_CHAR = dashpalUuid('0005');
/** The pairing and session handshakes (open; ./auth.ts). */
export const AUTH_CHAR = dashpalUuid('0006');
/** The setup's aiming picture: notify only, records sealed in direction 3, only to the setup hold's connection. */
export const VIEW_CHAR = dashpalUuid('0007');

/** What a DashPal's advertised service says about it. */
export type AdvState = 'closed' | 'new' | 'setup' | 'open';

/** The state an advert's service UUIDs name (the first DashPal one), or null for none. */
export function advOf(uuids: readonly string[] | null | undefined): AdvState | null {
  for (const raw of uuids ?? []) {
    const u = raw.toLowerCase();
    if (u === PAIRING_NEW) return 'new';
    if (u === PAIRING_SETUP) return 'setup';
    if (u === PAIRING_OPEN) return 'open';
    if (u === DASHPAL_SERVICE) return 'closed';
  }
  return null;
}

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
  // 0x09 is never used
  AIM: 0x0a,
  VIEW_STATE: 0x0b,
  SETUP_RESULT: 0x0c,
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
  [TX_TYPE.AIM]: 9,
  [TX_TYPE.VIEW_STATE]: 6,
  [TX_TYPE.SETUP_RESULT]: 5,
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
/** The full INFO: the first 14 bytes and the reader's connection nonce `Nc`. */
export const INFO_LEN_V2 = 30;
export const INFO_VERSION = 1;
/** INFO `flags` bits (bits 2-7 are written 0 and ignored). */
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
  'CAMERA_AIM',
];

export const EV = { MICROSLEEP: 0, SLEEP: 1, UNRESPONSIVE: 2, CRITICAL_STAND_DOWN: 31, CAMERA_AIM: 32 } as const;

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
  /** the camera needs re-aiming (its aim watch; kept by the dashcam across power cycles; firmware 3.6) */
  REAIM: 1 << 7,
} as const;

/**
 * ALERT `sound`. NO_FACE (6): the driver's face out of view while the phone reports the car moving;
 * continuous, tier 2, silent on both outputs while no phone is live.
 * COMMAND 6 (test sound) takes 1–5 only.
 */
export const SOUND = { GLANCE: 1, DROWSY: 2, WAKE: 3, PHONE: 4, CHIME: 5, NO_FACE: 6 } as const;
export type AlertSound = 1 | 2 | 3 | 4 | 5 | 6;

/** ALERT_STOP `reason`. */
export const STOP_REASON = { CLEARED: 0, SUPERSEDED: 1, MUTED: 2 } as const;
/**
 * ALERT_FALLBACK `cause`: 1 no ACK in time, 2 the phone said cannot, 3 the phone was lost (another
 * primary, a disconnect, a fresh STATE without can_play, the phone gone quiet, its hello again),
 * 4 reserved: the dashcam never sends it, and a phone that gets it keeps playing.
 */
export const FALLBACK_CAUSE = { NO_ACK: 1, CANNOT: 2, LOST: 3, ESCALATION: 4 } as const;

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
  /** commit the setup hold: SETUP_RESULT(8, …) */
  SETUP_DONE: 8,
  /** undo the setup hold: SETUP_RESULT(9, …), then the connection ends 1 s later */
  SETUP_CANCEL: 9,
  /** the aiming stream (`arg`: AIM_ARG) */
  AIM: 10,
  /** an aiming image is complete or given up (`arg`: its frame number) */
  VIEW_ACK: 11,
} as const;

/** COMMAND 10 `arg`. */
export const AIM_ARG = { STOP: 0, START: 1, QUERY: 2 } as const;

/** VIEW_STATE `reason`: why the aiming stream is refused or stopped (0: on, or stopped by the phone). */
export const VIEW_REASONS = ['ok', 'not_allowed', 'moving', 'drive', 'budget', 'busy', 'camera', 'memory', 'no_state', 'hold_ended', 'mtu'] as const;
export type ViewReason = (typeof VIEW_REASONS)[number];
/** A VIEW_STATE reason's name; a code this app does not know reads as `camera` (not ready). */
export const viewReason = (code: number): ViewReason => VIEW_REASONS[code] ?? 'camera';

/** ALERT_ACK `outcome`. */
export const ACK_OUTCOME = { CANNOT: 0, PLAYING: 1 } as const;

/** STATE `local_min` when the phone does not know the local time. */
export const LOCAL_MIN_UNKNOWN = 0xffff;
/** How long a STATE counts as fresh at the dashcam, in 0.1 s (it clamps 10-50). */
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

/** The aiming score of the newest camera frame (the setup's aiming stream only). */
export interface AimFrame {
  type: 'AIM';
  /** camera frame counter mod 256 */
  seq: number;
  /** 0-100 (a receiver clamps above 100) */
  score: number;
  /** the hint code (0 good … 13 too dark) */
  hint: number;
  /** bit 0 face, bit 1 fully in frame, bit 2 good */
  flags: number;
  /** the eye distance × 500, saturating at 255 */
  iod: number;
  /** degrees */
  yaw: number;
  pitch: number;
}

/** The aiming stream's state: `on` 1 on or still on, 0 stopped or refused; `leftS` the seconds it may still run. */
export interface ViewStateFrame {
  type: 'VIEW_STATE';
  on: number;
  reason: number;
  leftS: number;
}

/** The answer to COMMAND 8 (commit) or 9 (cancel), and the setup hold's expiry (9, R_EXPIRED). */
export interface SetupResultFrame {
  type: 'SETUP_RESULT';
  op: number;
  code: number;
  /** the phones stored after it */
  bondCount: number;
}

export type TxFrame = Hello | Status | DashcamEventFrame | AlertFrame | AlertStop | AlertFallback | TimeEcho | Paired | AimFrame | ViewStateFrame | SetupResultFrame;

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
  /** link v1's bond flag; always false since link v2 (no Bluetooth bonding) */
  peerBonded: boolean;
  /** phones paired with the dashcam (0-4), plus 1 for a provisional phone while a setup hold lasts */
  bondCount: number;
  /** INFO flags bit 0: the pairing window is open (also while a setup hold lasts) */
  pairingOpen: boolean;
  /** INFO flags bit 1: another link holds the setup claim or the setup hold (another phone is setting this dashcam up) */
  setupBusy: boolean;
  /** this connection's 16-byte nonce `Nc` (bytes 14-29); null from a shorter INFO */
  nonce: number[] | null;
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
    case TX_TYPE.AIM:
      return { ok: true, frame: { type: 'AIM', seq: u8(b, 2), score: u8(b, 3), hint: u8(b, 4), flags: u8(b, 5), iod: u8(b, 6), yaw: i8(b, 7), pitch: i8(b, 8) } };
    case TX_TYPE.VIEW_STATE:
      return { ok: true, frame: { type: 'VIEW_STATE', on: u8(b, 2), reason: u8(b, 3), leftS: u16(b, 4) } };
    case TX_TYPE.SETUP_RESULT:
      return { ok: true, frame: { type: 'SETUP_RESULT', op: u8(b, 2), code: u8(b, 3), bondCount: u8(b, 4) } };
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
    case 'AIM':
      return header(TX_TYPE.AIM).u8(f.seq).u8(f.score).u8(f.hint).u8(f.flags).u8(f.iod).i8(f.yaw).i8(f.pitch).bytes;
    case 'VIEW_STATE':
      return header(TX_TYPE.VIEW_STATE).u8(f.on).u8(f.reason).u16(f.leftS).bytes;
    case 'SETUP_RESULT':
      return header(TX_TYPE.SETUP_RESULT).u8(f.op).u8(f.code).u8(f.bondCount).bytes;
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

/** The INFO read: ≥ 14 bytes (trailing ignored), `ver` 1; `Nc` only from 30 bytes or more. Null for anything else. */
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
    nonce: bytes.length >= INFO_LEN_V2 ? Array.from({ length: 16 }, (_, i) => u8(bytes, 14 + i)) : null,
  };
}

/**
 * The INFO bytes (the dashcam's side; tests). `setupBusy` defaults to false; with a `nonce` the
 * 30-byte INFO, else the 14 bytes.
 */
export function encodeInfo(info: Omit<DashcamInfo, 'dashcamId' | 'name' | 'setupBusy' | 'nonce'> & { setupBusy?: boolean; nonce?: ArrayLike<number> | null }): number[] {
  const w = new Writer().u8(info.ver).u8(info.protoMin).u8(info.protoMax).u8(info.fwMajor).u8(info.fwMinor);
  for (let i = 0; i < 6; i++) w.u8(info.mac[i] ?? 0);
  const flags = (info.pairingOpen ? INFO_FLAG.PAIRING_OPEN : 0) | (info.setupBusy ? INFO_FLAG.SETUP_BUSY : 0);
  w.u8(info.peerBonded ? 1 : 0).u8(info.bondCount).u8(flags);
  if (info.nonce) for (let i = 0; i < 16; i++) w.u8(info.nonce[i] ?? 0);
  return w.bytes;
}

/**
 * Whether the dashcam speaks this app's link (v3): null when its INFO `proto` range includes it;
 * `firmware` when the DashPal is older (update its firmware), `app` when it is newer (update RoadWise).
 */
export function linkMismatch(info: Pick<DashcamInfo, 'protoMin' | 'protoMax'>): 'firmware' | 'app' | null {
  if (info.protoMax < LINK_VERSION) return 'firmware';
  if (info.protoMin > LINK_VERSION) return 'app';
  return null;
}

/** `DashPal-XXXX`: the last 4 hex characters of the dashcam id, upper case. */
export const nameOf = (dashcamId: string): string => `DashPal-${dashcamId.slice(-4).toUpperCase()}`;

/** A lowercase 12-hex-char dashcam id. */
export const isDashcamId = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{12}$/.test(s);

export const toHex = (bytes: ArrayLike<number>): string => Array.from(bytes, (b) => hex2(b & 0xff)).join('');
export function fromHex(hex: string): number[] {
  const clean = hex.replace(/\s+/g, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

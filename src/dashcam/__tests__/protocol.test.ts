import {
  DETAIL,
  EV,
  decodeInfo,
  decodeRx,
  decodeTx,
  encodeInfo,
  encodeRx,
  encodeTx,
  eventName,
  fromHex,
  isDashcamId,
  advOf,
  COMMAND,
  DASHPAL_SERVICE,
  INFO_FLAG,
  LINK_VERSION,
  linkMismatch,
  MAX_FRAME_BYTES,
  nameOf,
  PAIRING_NEW,
  PAIRING_OPEN,
  PAIRING_SETUP,
  STATUS_FLAG,
  toHex,
  VIEW_CHAR,
  viewReason,
  type RxFrame,
  type TxFrame,
} from '../protocol';

// The golden vectors, a byte-identical copy of the firmware's `tests/ble_vectors.json`.
import vectors from '../__fixtures__/ble_vectors.json';
import { sha256, utf8 } from '../crypto';

type Fields = Record<string, number | string>;
interface FrameVector {
  desc: string;
  dir: 'tx' | 'rx';
  type: string;
  fields: Fields;
  hex: string;
}
interface InvalidVector {
  desc: string;
  dir: 'tx' | 'rx';
  hex: string;
  reason: 'short' | 'type' | 'version';
}
interface InfoVector {
  desc: string;
  fields: Fields;
  hex: string;
  dashcam_id: string;
  name: string;
}
interface InfoV2Vector {
  desc: string;
  hex: string;
  fields: { ver: number; proto_min: number; proto_max: number; fw_major: number; fw_minor: number; mac: string; peer_bonded: number; bond_count: number; flags: number; nc: string };
}
const V2 = (vectors as unknown as { v2: { link_version: number; info: { len: number; valid: InfoV2Vector[] } } }).v2;
interface V3Section {
  link_version: number;
  adv: { suffix: string; uuid: string; state: string }[];
  info: { len: number; valid: InfoV2Vector[] };
  results: { code: number; name: string; hex: string }[];
  schema: Record<string, { type: number; dir: string; len: number; fields: [string, string][] }>;
  valid: FrameVector[];
  invalid: InvalidVector[];
}
const V3 = (vectors as unknown as { v3: V3Section }).v3;
const V = vectors as unknown as {
  version: number;
  max_frame_len: number;
  valid: FrameVector[];
  decode_only: FrameVector[];
  invalid: InvalidVector[];
  info: { valid: InfoVector[]; decode_only: InfoVector[]; invalid: { desc: string; hex: string; reason: string }[] };
};

const n = (f: Fields, k: string): number => {
  const v = f[k];
  if (typeof v !== 'number') throw new Error(`field ${k} missing`);
  return v;
};

/** The vector's snake_case fields as the codec's typed frame. */
function frameOf(v: FrameVector): TxFrame | RxFrame {
  const f = v.fields;
  switch (v.type) {
    case 'HELLO':
      return { type: 'HELLO', bootId: n(f, 'boot_id'), nextSeq: n(f, 'next_seq'), oldestSeq: n(f, 'oldest_seq'), uptimeMs: n(f, 'uptime_ms') };
    case 'STATUS':
      return { type: 'STATUS', uptimeMs: n(f, 'uptime_ms'), state: n(f, 'state'), flags: n(f, 'flags'), fpsX10: n(f, 'fps_x10'), tempC: n(f, 'temp_c'), bondCount: n(f, 'bond_count') };
    case 'EVENT':
      return {
        type: 'EVENT',
        seq: n(f, 'seq'),
        tMs: n(f, 't_ms'),
        durDs: n(f, 'dur_ds'),
        ev: n(f, 'ev'),
        tier: n(f, 'tier_aud') & 0x03,
        audible: (n(f, 'tier_aud') & 0x80) !== 0,
        detail: n(f, 'detail'),
        valueX10: n(f, 'value_x10'),
      };
    case 'ALERT':
      return { type: 'ALERT', alertId: n(f, 'alert_id'), sound: n(f, 'sound'), tier: n(f, 'tier'), level: n(f, 'level'), mode: n(f, 'mode'), route: n(f, 'route'), uptimeMs: n(f, 'uptime_ms') };
    case 'ALERT_STOP':
      return { type: 'ALERT_STOP', alertId: n(f, 'alert_id'), reason: n(f, 'reason') };
    case 'ALERT_FALLBACK':
      return { type: 'ALERT_FALLBACK', alertId: n(f, 'alert_id'), cause: n(f, 'cause') };
    case 'TIME_ECHO':
      return { type: 'TIME_ECHO', reqId: n(f, 'req_id'), uptimeMs: n(f, 'uptime_ms') };
    case 'PAIRED':
      return { type: 'PAIRED', bondCount: n(f, 'bond_count') };
    case 'STATE':
      return { type: 'STATE', flags: n(f, 'flags'), ttlDs: n(f, 'ttl_ds'), speedCms: n(f, 'speed_cms'), localMin: n(f, 'local_min'), bootId: n(f, 'boot_id'), ackSeq: n(f, 'ack_seq') };
    case 'ACK':
      return { type: 'ACK', bootId: n(f, 'boot_id'), ackSeq: n(f, 'ack_seq') };
    case 'ALERT_ACK':
      return { type: 'ALERT_ACK', alertId: n(f, 'alert_id'), outcome: n(f, 'outcome') };
    case 'TIME_PING':
      return { type: 'TIME_PING', reqId: n(f, 'req_id'), epochMs: n(f, 'epoch_ms') };
    case 'RESUME':
      return { type: 'RESUME', bootId: n(f, 'boot_id'), nextSeq: n(f, 'next_seq') };
    case 'COMMAND':
      return { type: 'COMMAND', op: n(f, 'op'), arg: n(f, 'arg') };
    case 'AIM':
      return { type: 'AIM', seq: n(f, 'seq'), score: n(f, 'score'), hint: n(f, 'hint'), flags: n(f, 'flags'), iod: n(f, 'iod'), yaw: n(f, 'yaw'), pitch: n(f, 'pitch') };
    case 'VIEW_STATE':
      return { type: 'VIEW_STATE', on: n(f, 'on'), reason: n(f, 'reason'), leftS: n(f, 'left_s') };
    case 'SETUP_RESULT':
      return { type: 'SETUP_RESULT', op: n(f, 'op'), code: n(f, 'code'), bondCount: n(f, 'bond_count') };
    default:
      throw new Error(`no frame type ${v.type}`);
  }
}

const decode = (dir: 'tx' | 'rx', hex: string) => (dir === 'tx' ? decodeTx(fromHex(hex)) : decodeRx(fromHex(hex)));
const encode = (f: TxFrame | RxFrame): number[] => (f.type in { STATE: 1, ACK: 1, ALERT_ACK: 1, TIME_PING: 1, RESUME: 1, COMMAND: 1 } ? encodeRx(f as RxFrame) : encodeTx(f as TxFrame));

test('the vectors are protocol v1 and cover every frame type in its direction', () => {
  expect(V.version).toBe(1);
  expect(V.max_frame_len).toBe(MAX_FRAME_BYTES);
  const tx = new Set(V.valid.filter((v) => v.dir === 'tx').map((v) => v.type));
  const rx = new Set(V.valid.filter((v) => v.dir === 'rx').map((v) => v.type));
  expect(tx).toEqual(new Set(['HELLO', 'STATUS', 'EVENT', 'ALERT', 'ALERT_STOP', 'ALERT_FALLBACK', 'TIME_ECHO', 'PAIRED']));
  expect(rx).toEqual(new Set(['STATE', 'ACK', 'ALERT_ACK', 'TIME_PING', 'RESUME', 'COMMAND']));
});

test.each(V.valid.map((v) => [v.desc, v] as const))('valid: %s — encodes to its bytes and decodes to its fields', (_d, v) => {
  const want = frameOf(v);
  expect(toHex(encode(want))).toBe(v.hex);
  expect(decode(v.dir, v.hex)).toEqual({ ok: true, frame: want });
  expect(fromHex(v.hex).length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
});

test.each(V.decode_only.map((v) => [v.desc, v] as const))('decode only: %s — trailing bytes and reserved bytes ignored', (_d, v) => {
  expect(decode(v.dir, v.hex)).toEqual({ ok: true, frame: frameOf(v) });
});

test.each(V.invalid.map((v) => [v.desc, v] as const))('invalid: %s — refused with its reason, never thrown', (_d, v) => {
  expect(decode(v.dir, v.hex)).toEqual({ ok: false, reason: v.reason });
});

test.each(V.info.valid.map((v) => [v.desc, v] as const))('INFO: %s — id, name and flags; encodes back', (_d, v) => {
  const info = decodeInfo(fromHex(v.hex));
  expect(info).not.toBeNull();
  expect(info!.dashcamId).toBe(v.dashcam_id);
  expect(info!.dashcamId).toBe(v.fields.mac);
  expect(isDashcamId(info!.dashcamId)).toBe(true);
  expect(info!.name).toBe(v.name);
  expect(info!.peerBonded).toBe(v.fields.peer_bonded === 1);
  expect(info!.bondCount).toBe(v.fields.bond_count);
  expect(info!.pairingOpen).toBe(((v.fields.flags as number) & 1) === 1);
  expect(info!.setupBusy).toBe(((v.fields.flags as number) & 2) === 2);
  expect(info!.fwMajor).toBe(v.fields.fw_major);
  expect(info!.fwMinor).toBe(v.fields.fw_minor);
  // link v1 INFO (14 bytes, proto 1): read, never spoken by this app (link v3)
  expect(linkMismatch(info!)).toBe('firmware');
  expect(info!.nonce).toBeNull();
  expect(toHex(encodeInfo(info!))).toBe(v.hex);
});

test.each(V.info.decode_only.map((v) => [v.desc, v] as const))('INFO decode only: %s', (_d, v) => {
  expect(decodeInfo(fromHex(v.hex))?.dashcamId).toBe(v.dashcam_id);
});

test.each(V.info.invalid.map((v) => [v.desc, v] as const))('INFO invalid: %s — refused', (_d, v) => {
  expect(decodeInfo(fromHex(v.hex))).toBeNull();
});

test('INFO flags bit 1 (another phone is setting the dashcam up) is in the vectors, decodes alone and encodes back', () => {
  expect(V.info.valid.some((v) => ((v.fields.flags as number) & 2) === 2)).toBe(true);
  const base = { ver: 1, protoMin: 1, protoMax: 1, fwMajor: 3, fwMinor: 3, mac: [0xa4, 0xcf, 0x12, 0x34, 0x56, 0x78], peerBonded: false, bondCount: 1 };
  const busyOnly = decodeInfo(encodeInfo({ ...base, pairingOpen: false, setupBusy: true }))!;
  expect([busyOnly.pairingOpen, busyOnly.setupBusy]).toEqual([false, true]);
  expect(encodeInfo({ ...base, pairingOpen: true }).at(-1)).toBe(1);
  expect(encodeInfo({ ...base, pairingOpen: true, setupBusy: true }).at(-1)).toBe(3);
});

test('the link version is the vectors’ v3 (3)', () => {
  expect(LINK_VERSION).toBe(V3.link_version);
  expect(V2.link_version).toBe(2);
});

test.each(V2.info.valid.map((v) => [v.desc, v] as const))('INFO v2 (frozen): %s — 30 bytes with this connection’s Nc; an older DashPal: update its firmware', (_d, v) => {
  const bytes = fromHex(v.hex);
  expect(bytes).toHaveLength(V2.info.len);
  const info = decodeInfo(bytes)!;
  expect(info.dashcamId).toBe(v.fields.mac);
  expect([info.protoMin, info.protoMax, info.fwMajor, info.fwMinor]).toEqual([v.fields.proto_min, v.fields.proto_max, v.fields.fw_major, v.fields.fw_minor]);
  expect(info.bondCount).toBe(v.fields.bond_count);
  expect(info.pairingOpen).toBe((v.fields.flags & INFO_FLAG.PAIRING_OPEN) !== 0);
  expect(info.setupBusy).toBe((v.fields.flags & INFO_FLAG.SETUP_BUSY) !== 0);
  expect(toHex(info.nonce!)).toBe(v.fields.nc);
  expect(linkMismatch(info)).toBe('firmware');
});

test.each(V3.info.valid.map((v) => [v.desc, v] as const))('INFO v3: %s', (_d, v) => {
  const bytes = fromHex(v.hex);
  expect(bytes).toHaveLength(V3.info.len);
  const info = decodeInfo(bytes)!;
  expect(info.dashcamId).toBe(v.fields.mac);
  expect(info.name).toBe(nameOf(v.fields.mac));
  expect([info.protoMin, info.protoMax, info.fwMajor, info.fwMinor]).toEqual([v.fields.proto_min, v.fields.proto_max, v.fields.fw_major, v.fields.fw_minor]);
  expect(info.peerBonded).toBe(false);
  expect(info.bondCount).toBe(v.fields.bond_count);
  expect(info.pairingOpen).toBe((v.fields.flags & 1) !== 0);
  expect(info.setupBusy).toBe((v.fields.flags & 2) !== 0);
  expect(toHex(info.nonce!)).toBe(v.fields.nc);
  if (v.fields.proto_max >= 3) {
    // spoken, and it encodes back (a v3 board never sets bit 2)
    expect(linkMismatch(info)).toBeNull();
    expect(toHex(encodeInfo(info))).toBe(v.hex);
  } else {
    // an older board: update its firmware; its bit 2 is ignored
    expect(linkMismatch(info)).toBe('firmware');
  }
});

test('a 14-byte INFO still decodes, with no Nc; linkMismatch both ways', () => {
  const v3 = decodeInfo(fromHex(V3.info.valid[0]!.hex))!;
  const short = decodeInfo(fromHex(V3.info.valid[0]!.hex).slice(0, 14))!;
  expect(short.nonce).toBeNull();
  expect(decodeInfo(fromHex(V3.info.valid[0]!.hex).slice(0, 29))!.nonce).toBeNull();
  expect(linkMismatch({ ...v3, protoMin: 1, protoMax: 2 })).toBe('firmware');
  expect(linkMismatch({ ...v3, protoMin: 4, protoMax: 4 })).toBe('app');
  expect(linkMismatch({ ...v3, protoMin: 2, protoMax: 4 })).toBeNull();
  expect(linkMismatch({ ...v3, protoMin: 3, protoMax: 3 })).toBeNull();
});

test.each(V3.adv.map((a) => [a.state, a] as const))('advertised %s: its UUID and advOf', (_s, a) => {
  expect(a.uuid).toBe(`d5a1${a.suffix}-7b3e-4c8a-9f21-0c6e5a7d2b10`);
  expect(advOf([a.uuid])).toBe(a.state);
  expect(advOf([a.uuid.toUpperCase()])).toBe(a.state);
});

test('the advertised services and the VIEW characteristic, and advOf of anything else', () => {
  expect([DASHPAL_SERVICE, PAIRING_NEW, PAIRING_SETUP, PAIRING_OPEN]).toEqual(V3.adv.map((a) => a.uuid));
  expect(VIEW_CHAR).toBe('d5a10007-7b3e-4c8a-9f21-0c6e5a7d2b10');
  expect(advOf([])).toBeNull();
  expect(advOf(undefined)).toBeNull();
  expect(advOf(['0000180a-0000-1000-8000-00805f9b34fb'])).toBeNull();
  expect(advOf(['0000180a-0000-1000-8000-00805f9b34fb', PAIRING_OPEN])).toBe('open');
});

test('the v3 frames are the schema’s: AIM, VIEW_STATE and SETUP_RESULT with their types and lengths', () => {
  expect(Object.fromEntries(Object.entries(V3.schema).map(([k, v]) => [k, [v.type, v.len, v.dir]]))).toEqual({ AIM: [0x0a, 9, 'tx'], VIEW_STATE: [0x0b, 6, 'tx'], SETUP_RESULT: [0x0c, 5, 'tx'] });
  expect(new Set(V3.valid.map((v) => v.type))).toEqual(new Set(['AIM', 'VIEW_STATE', 'SETUP_RESULT', 'COMMAND']));
  expect(new Set(V3.valid.filter((v) => v.type === 'COMMAND').map((v) => n(v.fields, 'op')))).toEqual(new Set([COMMAND.SETUP_DONE, COMMAND.SETUP_CANCEL, COMMAND.AIM, COMMAND.VIEW_ACK]));
});

test.each(V3.valid.map((v) => [v.desc, v] as const))('v3 valid: %s — encodes to its bytes and decodes to its fields', (_d, v) => {
  const want = frameOf(v);
  expect(toHex(encode(want))).toBe(v.hex);
  expect(decode(v.dir, v.hex)).toEqual({ ok: true, frame: want });
  expect(fromHex(v.hex).length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
});

test.each(V3.invalid.map((v) => [v.desc, v] as const))('v3 invalid: %s — refused with its reason', (_d, v) => {
  expect(decode(v.dir, v.hex)).toEqual({ ok: false, reason: v.reason });
});

test('TX 0x09 is never a type; RX 0x87 and 0x88 are not types', () => {
  expect(decodeTx([0x09, 1, 0, 0, 0, 0, 0, 0, 0, 0])).toEqual({ ok: false, reason: 'type' });
  expect(decodeRx([0x87, 1, 0, 0])).toEqual({ ok: false, reason: 'type' });
  expect(decodeRx([0x88, 1, ...new Array<number>(16).fill(0)])).toEqual({ ok: false, reason: 'type' });
});

test('VIEW_STATE reasons by name; a code this app does not know reads as camera', () => {
  expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(viewReason)).toEqual(['ok', 'not_allowed', 'moving', 'drive', 'budget', 'busy', 'camera', 'memory', 'no_state', 'hold_ended', 'mtu']);
  expect(viewReason(11)).toBe('camera');
});

/** Python's `json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)`. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

test('v2 is frozen: its canonical SHA-256 is the pinned one; v2 then v3 are the last keys', () => {
  const all = vectors as unknown as Record<string, unknown>;
  expect(toHex(sha256(utf8(canonical(all.v2))))).toBe('59fa278ea76d21e008062f6fe819fa40c5a8c7f7a57ad0e9079e730744873d52');
  expect(Object.keys(all).slice(-2)).toEqual(['v2', 'v3']);
});

test('encoders clamp out-of-range values instead of wrapping', () => {
  const ev = decodeTx(encodeTx({ type: 'EVENT', seq: 1, tMs: 2, durDs: 70000, ev: 3, tier: 2, audible: true, detail: 0, valueX10: 99999 }));
  expect(ev).toMatchObject({ ok: true, frame: { durDs: 65535, valueX10: 32767, tier: 2, audible: true } });
  const neg = decodeTx(encodeTx({ type: 'EVENT', seq: 1, tMs: 2, durDs: -3, ev: 3, tier: 1, audible: false, detail: 0, valueX10: -99999 }));
  expect(neg).toMatchObject({ ok: true, frame: { durDs: 0, valueX10: -32768, audible: false } });
  const st = decodeRx(encodeRx({ type: 'STATE', flags: 0, ttlDs: 30, speedCms: 1e9, localMin: 0xffff, bootId: 2 ** 32 - 1, ackSeq: NaN }));
  expect(st).toMatchObject({ ok: true, frame: { speedCms: 65535, bootId: 4294967295, ackSeq: 0 } });
});

test('every EVENT detail code the firmware sends has a vector, and the app names each one', () => {
  const details = new Set(V.valid.filter((v) => v.type === 'EVENT').map((v) => n(v.fields, 'detail')));
  expect([...details].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  expect(Object.values(DETAIL).sort()).toEqual([0, 1, 2, 3, 4, 5]);
  const standDown = V.valid.find((v) => v.type === 'EVENT' && n(v.fields, 'ev') === EV.CRITICAL_STAND_DOWN)!;
  expect(decodeTx(fromHex(standDown.hex))).toEqual({
    ok: true,
    frame: expect.objectContaining({ ev: 31, tier: 0, audible: false, detail: DETAIL.FACE_GONE }),
  });
});

test('event names follow the frozen engine order; unknown ids read UNKNOWN_<n>', () => {
  expect(eventName(0)).toBe('MICROSLEEP');
  expect(eventName(2)).toBe('UNRESPONSIVE');
  expect(eventName(30)).toBe('PHONE_HANDHELD');
  expect(eventName(31)).toBe('CRITICAL_STAND_DOWN');
  expect(eventName(32)).toBe('CAMERA_AIM');
  expect(eventName(33)).toBe('UNKNOWN_33');
  expect(eventName(255)).toBe('UNKNOWN_255');
});

test('STATUS bit 7: the camera needs re-aiming (the aim watch, firmware 3.6)', () => {
  expect(STATUS_FLAG.REAIM).toBe(0x80);
  const bytes = encodeTx({ type: 'STATUS', uptimeMs: 5, state: 3, flags: STATUS_FLAG.REAIM | STATUS_FLAG.CALIBRATED, fpsX10: 200, tempC: 40, bondCount: 1 });
  expect(decodeTx(bytes)).toEqual({ ok: true, frame: expect.objectContaining({ type: 'STATUS', flags: 0x88 }) });
});

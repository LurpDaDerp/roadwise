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
  MAX_FRAME_BYTES,
  speaksV1,
  toHex,
  type RxFrame,
  type TxFrame,
} from '../protocol';

// The golden vectors, a byte-identical copy of the firmware's `tests/ble_vectors.json` (plan §3, §9).
import vectors from '../__fixtures__/ble_vectors.json';

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
  expect(speaksV1(info!)).toBe(true);
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

test('a protocol range without v1 is not spoken', () => {
  const info = decodeInfo(fromHex(V.info.valid[0]!.hex))!;
  expect(speaksV1({ ...info, protoMin: 2, protoMax: 3 })).toBe(false);
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
  expect(eventName(32)).toBe('UNKNOWN_32');
  expect(eventName(255)).toBe('UNKNOWN_255');
});

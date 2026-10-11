import {
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

// The golden vectors shared byte-for-byte with the firmware (plan §3, §9).
const vectors = require('../__fixtures__/ble_vectors.json') as {
  protocol: number;
  tx: { name: string; type: number; hex: string; fields: Record<string, number> }[];
  rx: { name: string; type: number; hex: string; fields: Record<string, number> }[];
  info: { name: string; hex: string; fields: Record<string, number | string>; dashcam_id: string; local_name: string }[];
  malformed_tx: { name: string; hex: string }[];
  longer_tx: { name: string; hex: string; same_as: string }[];
};

/** The vector's snake_case fields as the codec's typed frame. */
function txFrame(type: number, f: Record<string, number>): TxFrame {
  switch (type) {
    case 0x01:
      return { type: 'HELLO', bootId: f.boot_id!, nextSeq: f.next_seq!, oldestSeq: f.oldest_seq!, uptimeMs: f.uptime_ms! };
    case 0x02:
      return { type: 'STATUS', uptimeMs: f.uptime_ms!, state: f.state!, flags: f.flags!, fpsX10: f.fps_x10!, tempC: f.temp_c!, bondCount: f.bond_count! };
    case 0x03:
      return {
        type: 'EVENT',
        seq: f.seq!,
        tMs: f.t_ms!,
        durDs: f.dur_ds!,
        ev: f.ev!,
        tier: f.tier_aud! & 0x03,
        audible: (f.tier_aud! & 0x80) !== 0,
        detail: f.detail!,
        valueX10: f.value_x10!,
      };
    case 0x04:
      return { type: 'ALERT', alertId: f.alert_id!, sound: f.sound!, tier: f.tier!, level: f.level!, mode: f.mode!, route: f.route!, uptimeMs: f.uptime_ms! };
    case 0x05:
      return { type: 'ALERT_STOP', alertId: f.alert_id!, reason: f.reason! };
    case 0x06:
      return { type: 'ALERT_FALLBACK', alertId: f.alert_id!, cause: f.cause! };
    case 0x07:
      return { type: 'TIME_ECHO', reqId: f.req_id!, uptimeMs: f.uptime_ms! };
    case 0x08:
      return { type: 'PAIRED', bondCount: f.bond_count! };
    default:
      throw new Error(`no tx type ${type}`);
  }
}

function rxFrame(type: number, f: Record<string, number>): RxFrame {
  switch (type) {
    case 0x81:
      return { type: 'STATE', flags: f.flags!, ttlDs: f.ttl_ds!, speedCms: f.speed_cms!, localMin: f.local_min!, bootId: f.boot_id!, ackSeq: f.ack_seq! };
    case 0x82:
      return { type: 'ACK', bootId: f.boot_id!, ackSeq: f.ack_seq! };
    case 0x83:
      return { type: 'ALERT_ACK', alertId: f.alert_id!, outcome: f.outcome! };
    case 0x84:
      return { type: 'TIME_PING', reqId: f.req_id!, epochMs: f.epoch_ms! };
    case 0x85:
      return { type: 'RESUME', bootId: f.boot_id!, nextSeq: f.next_seq! };
    case 0x86:
      return { type: 'COMMAND', op: f.op!, arg: f.arg! };
    default:
      throw new Error(`no rx type ${type}`);
  }
}

test('the vectors are protocol v1 and cover every frame type both ways', () => {
  expect(vectors.protocol).toBe(1);
  expect(new Set(vectors.tx.map((v) => v.type))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8]));
  expect(new Set(vectors.rx.map((v) => v.type))).toEqual(new Set([0x81, 0x82, 0x83, 0x84, 0x85, 0x86]));
});

describe.each(vectors.tx.map((v) => [v.name, v] as const))('TX vector %s', (_name, v) => {
  test('decodes to its fields and encodes back to the same bytes', () => {
    const want = txFrame(v.type, v.fields);
    const got = decodeTx(fromHex(v.hex));
    expect(got).toEqual({ ok: true, frame: want });
    expect(toHex(encodeTx(want))).toBe(v.hex);
    expect(fromHex(v.hex).length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });
});

describe.each(vectors.rx.map((v) => [v.name, v] as const))('RX vector %s', (_name, v) => {
  test('encodes to the same bytes and decodes back', () => {
    const want = rxFrame(v.type, v.fields);
    expect(toHex(encodeRx(want))).toBe(v.hex);
    expect(decodeRx(fromHex(v.hex))).toEqual({ ok: true, frame: want });
    expect(fromHex(v.hex).length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });
});

describe.each(vectors.info.map((v) => [v.name, v] as const))('INFO vector %s', (_name, v) => {
  test('decodes the id, name and flags; encodes back', () => {
    const info = decodeInfo(fromHex(v.hex));
    expect(info).not.toBeNull();
    expect(info!.dashcamId).toBe(v.dashcam_id);
    expect(isDashcamId(info!.dashcamId)).toBe(true);
    expect(info!.name).toBe(v.local_name);
    expect(info!.peerBonded).toBe(v.fields.peer_bonded === 1);
    expect(info!.bondCount).toBe(v.fields.bond_count);
    expect(info!.pairingOpen).toBe(((v.fields.flags as number) & 1) === 1);
    expect(info!.fwMajor).toBe(v.fields.fw_major);
    expect(speaksV1(info!)).toBe(true);
    expect(toHex(encodeInfo(info!))).toBe(v.hex);
  });
});

test.each(vectors.malformed_tx.map((v) => [v.name, v.hex] as const))('malformed TX %s is refused, never thrown', (_name, hex) => {
  const got = decodeTx(fromHex(hex));
  expect(got.ok).toBe(false);
});

test.each(vectors.longer_tx.map((v) => [v.name, v] as const))('a longer TX frame (%s) is accepted, trailing bytes ignored', (_name, v) => {
  const base = vectors.tx.find((t) => t.name === v.same_as)!;
  expect(decodeTx(fromHex(v.hex))).toEqual(decodeTx(fromHex(base.hex)));
});

test('refusal reasons', () => {
  expect(decodeTx([])).toEqual({ ok: false, reason: 'empty' });
  expect(decodeTx([1])).toEqual({ ok: false, reason: 'short' });
  expect(decodeTx([0x09, 1, 0, 0])).toEqual({ ok: false, reason: 'unknown_type' });
  expect(decodeTx([0x01, 2, ...new Array(16).fill(0)])).toEqual({ ok: false, reason: 'version' });
  expect(decodeTx([0x01, 1, 0])).toEqual({ ok: false, reason: 'short' });
  // A phone → dashcam type is not a TX frame (and vice versa).
  expect(decodeTx(encodeRx({ type: 'ACK', bootId: 1, ackSeq: 2 }))).toEqual({ ok: false, reason: 'unknown_type' });
  expect(decodeRx(encodeTx({ type: 'PAIRED', bondCount: 1 }))).toEqual({ ok: false, reason: 'unknown_type' });
});

test('INFO: shorter or another version is null; trailing bytes are ignored', () => {
  const v = vectors.info[0]!;
  const bytes = fromHex(v.hex);
  expect(decodeInfo(bytes.slice(0, 13))).toBeNull();
  expect(decodeInfo([2, ...bytes.slice(1)])).toBeNull();
  expect(decodeInfo([...bytes, 1, 2, 3])).toEqual(decodeInfo(bytes));
  expect(speaksV1({ ...decodeInfo(bytes)!, protoMin: 2, protoMax: 3 })).toBe(false);
});

test('encoders clamp out-of-range values instead of wrapping', () => {
  const ev = decodeTx(encodeTx({ type: 'EVENT', seq: 1, tMs: 2, durDs: 70000, ev: 3, tier: 2, audible: true, detail: 0, valueX10: 99999 }));
  expect(ev).toMatchObject({ ok: true, frame: { durDs: 65535, valueX10: 32767, tier: 2, audible: true } });
  const neg = decodeTx(encodeTx({ type: 'EVENT', seq: 1, tMs: 2, durDs: -3, ev: 3, tier: 1, audible: false, detail: 0, valueX10: -99999 }));
  expect(neg).toMatchObject({ ok: true, frame: { durDs: 0, valueX10: -32768, audible: false } });
  const st = decodeRx(encodeRx({ type: 'STATE', flags: 0, ttlDs: 30, speedCms: 1e9, localMin: 0xffff, bootId: 2 ** 32 - 1, ackSeq: NaN }));
  expect(st).toMatchObject({ ok: true, frame: { speedCms: 65535, bootId: 4294967295, ackSeq: 0 } });
});

test('TIME_PING carries a full 64-bit epoch in ms', () => {
  const epochMs = 1_791_600_000_123;
  expect(decodeRx(encodeRx({ type: 'TIME_PING', reqId: 65535, epochMs }))).toEqual({ ok: true, frame: { type: 'TIME_PING', reqId: 65535, epochMs } });
});

test('event names follow the frozen engine order; unknown ids read UNKNOWN_<n>', () => {
  expect(eventName(0)).toBe('MICROSLEEP');
  expect(eventName(2)).toBe('UNRESPONSIVE');
  expect(eventName(30)).toBe('PHONE_HANDHELD');
  expect(eventName(31)).toBe('UNKNOWN_31');
  expect(eventName(255)).toBe('UNKNOWN_255');
});

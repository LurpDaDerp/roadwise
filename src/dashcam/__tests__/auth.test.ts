// The phone's handshakes and sealed frames, byte for byte against the shared vectors (`v2` frozen,
// `v3` the link this app speaks; written by the firmware's tools/make_auth_vectors.py and reproduced
// there by mbedTLS).
import vectors from '../__fixtures__/ble_vectors.json';
import {
  acceptCounter,
  addPhoneFrame,
  AUTH_MSG,
  blindedId,
  createSealer,
  CTR_LAST,
  DIR_DP,
  DIR_PD,
  DIR_VIEW,
  newWindow,
  openRaw,
  PAIR_OPEN_LEN,
  pairFin,
  pairKeys,
  pairKeysV3,
  pairOpen,
  pairRequest,
  parseAuthRecord,
  proofOk,
  R,
  resultRecord,
  sealRaw,
  sealView,
  sessionFin,
  sessionKeys,
  sessionRequest,
  VIEW_RECORD_MAX,
} from '../auth';
import { x25519Public, x25519Shared } from '../crypto';
import { decodeInfo, fromHex, toHex } from '../protocol';

type Hex = string;
interface V2 {
  x25519: { alice_priv: Hex; alice_pub: Hex; bob_priv: Hex; bob_pub: Hex; shared: Hex };
  pair: {
    a: Hex; A: Hex; b: Hex; B: Hex; nc: Hex; np: Hex; nd: Hex; id_p: Hex; pair_req: Hex; Z: Hex; T_pair: Hex; K_pair: Hex; k_conf: Hex;
    proof_d: Hex; proof_p: Hex; pair_resp: Hex; pair_fin: Hex; S: Hex; mac: Hex;
    other_nc: { nc: Hex; pair_req: Hex; against_nc: Hex; expect: string };
    prev_proven: { prev_id: Hex; prev_k_pair: Hex; prev_proof: Hex; id_p: Hex; pair_req: Hex; expect: string };
    prev_unproven: { prev_id: Hex; pair_req: Hex; expect: string };
    under_once: { S1: Hex; pair_req: Hex; pair_resp: Hex; K_pair: Hex };
  };
  session: {
    K_pair: Hex; id_p: Hex; mac: Hex; nc: Hex; np: Hex; nd: Hex; bid: Hex; session_req: Hex; T_s: Hex; k_dp: Hex; k_pd: Hex; k_conf: Hex;
    session_resp: Hex; session_fin: Hex; bid_other_nc: { nc: Hex; bid: Hex };
  };
  result: { code: number; name: string; hex: Hex }[];
  add_phone: { S1: Hex; hex: Hex };
  sealed: { desc: string; dir: number; key: 'k_dp' | 'k_pd'; ctr: number; plain: Hex; wire: Hex }[];
  sealed_invalid: { desc: string; dir: number; key: 'k_dp' | 'k_pd'; wire: Hex; accepted?: number[]; expect: 'bad' | 'replay' | 'ok' }[];
  info: { valid: { hex: Hex; fields: Record<string, number | string> }[] };
}
const V = (vectors as unknown as { v2: V2 }).v2;
const b = (h: Hex): Uint8Array => Uint8Array.from(fromHex(h));
const P = V.pair;
const S = V.session;

describe('X25519 (RFC 7748 §6.1)', () => {
  test('both public keys and the shared secret', () => {
    expect(toHex(x25519Public(b(V.x25519.alice_priv)))).toBe(V.x25519.alice_pub);
    expect(toHex(x25519Public(b(V.x25519.bob_priv)))).toBe(V.x25519.bob_pub);
    expect(toHex(x25519Shared(b(V.x25519.alice_priv), b(V.x25519.bob_pub))!)).toBe(V.x25519.shared);
    expect(toHex(x25519Shared(b(V.x25519.bob_priv), b(V.x25519.alice_pub))!)).toBe(V.x25519.shared);
  });

  test('a low-order point (all-zero result) is refused', () => {
    expect(x25519Shared(b(V.x25519.alice_priv), new Uint8Array(32))).toBeNull();
    const one = new Uint8Array(32);
    one[0] = 1;
    expect(x25519Shared(b(V.x25519.alice_priv), one)).toBeNull();
    expect(x25519Shared(b(V.x25519.alice_priv), new Uint8Array(31))).toBeNull();
  });
});

describe('pairing', () => {
  const base = { code: b(P.S), mac: b(P.mac), nc: b(P.nc), idP: b(P.id_p), a: b(P.a), np: b(P.np) };

  test('PAIR_REQ, the keys from PAIR_RESP, the proofs and PAIR_FIN', () => {
    const req = pairRequest(base);
    expect(toHex(req.A)).toBe(P.A);
    expect(toHex(req.bytes)).toBe(P.pair_req);
    const resp = parseAuthRecord(b(P.pair_resp));
    expect(resp.kind).toBe('pair_resp');
    if (resp.kind !== 'pair_resp') return;
    expect(toHex(resp.B)).toBe(P.B);
    expect(toHex(resp.Nd)).toBe(P.nd);
    const k = pairKeys({ code: base.code, mac: base.mac, nc: base.nc, req: req.bytes, a: base.a, B: resp.B, Nd: resp.Nd })!;
    expect(toHex(x25519Shared(b(P.a), b(P.B))!)).toBe(P.Z);
    expect(toHex(k.T_pair)).toBe(P.T_pair);
    expect(toHex(k.K_pair)).toBe(P.K_pair);
    expect(toHex(k.k_conf)).toBe(P.k_conf);
    expect(toHex(k.proofD)).toBe(P.proof_d);
    expect(proofOk(k.proofD, resp.proofD)).toBe(true);
    expect(toHex(k.proofP)).toBe(P.proof_p);
    expect(toHex(pairFin(k.proofP))).toBe(P.pair_fin);
  });

  test('a wrong dashcam proof is refused (one flipped bit), and the wrong code gives other keys', () => {
    const req = pairRequest(base);
    const resp = parseAuthRecord(b(P.pair_resp));
    if (resp.kind !== 'pair_resp') throw new Error('vector');
    const k = pairKeys({ code: base.code, mac: base.mac, nc: base.nc, req: req.bytes, a: base.a, B: resp.B, Nd: resp.Nd })!;
    const bad = Uint8Array.from(resp.proofD);
    bad[5] = bad[5]! ^ 0x01;
    expect(proofOk(k.proofD, bad)).toBe(false);
    const other = pairKeys({ code: new Uint8Array(16).fill(9), mac: base.mac, nc: base.nc, req: req.bytes, a: base.a, B: resp.B, Nd: resp.Nd })!;
    expect(proofOk(other.proofD, resp.proofD)).toBe(false);
    // the dashcam's key refused
    expect(pairKeys({ code: base.code, mac: base.mac, nc: base.nc, req: req.bytes, a: base.a, B: new Uint8Array(32), Nd: resp.Nd })).toBeNull();
  });

  test('the same request over another Nc has another tag (the dashcam answers R_WRONG_CODE to the first one there)', () => {
    const other = pairRequest({ ...base, nc: b(P.other_nc.nc) });
    expect(toHex(other.bytes)).toBe(P.other_nc.pair_req);
    expect(toHex(other.bytes)).not.toBe(P.pair_req);
    expect(P.other_nc.expect).toBe('R_WRONG_CODE');
  });

  test('a proven prev_id (prev_proof under its key, bound to the new id) and an unproven one', () => {
    const proven = pairRequest({ ...base, idP: b(P.prev_proven.id_p), prev: { id: b(P.prev_proven.prev_id), kPair: b(P.prev_proven.prev_k_pair) } });
    expect(toHex(proven.bytes)).toBe(P.prev_proven.pair_req);
    expect(toHex(proven.bytes.slice(18, 34))).toBe(P.prev_proven.prev_proof);
    // The unproven vector carries prev_id with a zero proof: a new phone at the dashcam.
    const unproven = b(P.prev_unproven.pair_req);
    expect(toHex(unproven.slice(10, 18))).toBe(P.prev_unproven.prev_id);
    expect(unproven.slice(18, 34).every((x) => x === 0)).toBe(true);
  });

  test('a request under the one-time code, and its keys', () => {
    const req = pairRequest({ ...base, code: b(P.under_once.S1) });
    expect(toHex(req.bytes)).toBe(P.under_once.pair_req);
    const resp = parseAuthRecord(b(P.under_once.pair_resp));
    if (resp.kind !== 'pair_resp') throw new Error('vector');
    const k = pairKeys({ code: b(P.under_once.S1), mac: base.mac, nc: base.nc, req: req.bytes, a: base.a, B: resp.B, Nd: resp.Nd })!;
    expect(proofOk(k.proofD, resp.proofD)).toBe(true);
    expect(toHex(k.K_pair)).toBe(P.under_once.K_pair);
  });

  test('inputs of the wrong size and a zero id are refused before anything is built', () => {
    expect(() => pairRequest({ ...base, idP: new Uint8Array(8) })).toThrow();
    expect(() => pairRequest({ ...base, nc: new Uint8Array(15) })).toThrow();
    expect(() => pairRequest({ ...base, code: new Uint8Array(17) })).toThrow();
  });
});

describe('session', () => {
  test('bid, SESSION_REQ, the keys, SESSION_RESP and SESSION_FIN', () => {
    expect(toHex(blindedId(b(S.K_pair), b(S.mac), b(S.nc)))).toBe(S.bid);
    expect(toHex(sessionRequest(b(S.K_pair), b(S.mac), b(S.nc), b(S.np)))).toBe(S.session_req);
    const k = sessionKeys(b(S.K_pair), b(S.mac), b(S.id_p), b(S.np), b(S.nd));
    expect(toHex(k.T_s)).toBe(S.T_s);
    expect(toHex(k.k_dp)).toBe(S.k_dp);
    expect(toHex(k.k_pd)).toBe(S.k_pd);
    expect(toHex(k.k_conf)).toBe(S.k_conf);
    const resp = parseAuthRecord(b(S.session_resp));
    expect(resp.kind).toBe('session_resp');
    if (resp.kind !== 'session_resp') return;
    expect(toHex(resp.Nd)).toBe(S.nd);
    expect(proofOk(k.proofD, resp.proofD)).toBe(true);
    expect(toHex(sessionFin(k.proofP))).toBe(S.session_fin);
  });

  test('the blinded id differs with the Nc and never shows the phone id', () => {
    const other = blindedId(b(S.K_pair), b(S.mac), b(S.bid_other_nc.nc));
    expect(toHex(other)).toBe(S.bid_other_nc.bid);
    expect(toHex(other)).not.toBe(S.bid);
    expect(S.bid).not.toBe(S.id_p);
  });
});

describe('the AUTH read value', () => {
  test.each(V.result)('RESULT $name', (r) => {
    expect(toHex(resultRecord(r.code))).toBe(r.hex);
    expect(parseAuthRecord(b(r.hex))).toEqual({ kind: 'result', code: r.code });
    expect((R as Record<string, number>)[r.name.slice(2)]).toBe(r.code);
  });

  test('pending, and malformed values (a transport fault, never a verdict)', () => {
    expect(parseAuthRecord([0])).toEqual({ kind: 'pending' });
    for (const bad of [[], [0, 0], [0xe0, 2], [0xe0, 1, 0], [0x90, 2, 1], [0xa0, 3, ...new Array(32).fill(0)], [0x55]]) {
      expect(parseAuthRecord(bad)).toEqual({ kind: 'bad' });
    }
  });
});

describe('ADD_PHONE', () => {
  test('the one-time code as its 18-byte frame', () => {
    expect(toHex(addPhoneFrame(b(V.add_phone.S1)))).toBe(V.add_phone.hex);
    expect(() => addPhoneFrame(new Uint8Array(15))).toThrow();
  });
});

describe('sealed frames', () => {
  const key = (k: 'k_dp' | 'k_pd'): Uint8Array => b(S[k]);

  test.each(V.sealed)('$desc seals to the vector and opens back', (v) => {
    const wire = sealRaw(key(v.key), v.dir, v.ctr, b(v.plain));
    expect(toHex(wire)).toBe(v.wire);
    const o = openRaw(key(v.key), v.dir, b(v.wire))!;
    expect(o.ctr).toBe(v.ctr);
    expect(toHex(o.frame)).toBe(v.plain);
  });

  test('a 20-byte frame seals to 40 bytes', () => {
    expect(sealRaw(key('k_pd'), DIR_PD, 7, new Uint8Array(20).fill(1))).toHaveLength(40);
    expect(() => sealRaw(key('k_pd'), DIR_PD, 0, new Uint8Array(21))).toThrow();
    expect(() => sealRaw(key('k_pd'), DIR_PD, 0, [1])).toThrow();
  });

  test.each(V.sealed_invalid)('$desc: $expect', (v) => {
    const w = newWindow();
    for (const c of v.accepted ?? []) expect(acceptCounter(w, c)).toBe(true);
    const o = openRaw(key(v.key), v.dir, b(v.wire));
    if (v.expect === 'bad') {
      expect(o).toBeNull();
      return;
    }
    expect(o).not.toBeNull();
    expect(acceptCounter(w, o!.ctr)).toBe(v.expect === 'ok');
  });

  test('the replay window mirrors the firmware: newer always, up to 63 behind once, a duplicate or 64 behind never', () => {
    const w = newWindow();
    expect(acceptCounter(w, 10)).toBe(true);
    expect(acceptCounter(w, 10)).toBe(false);
    expect(acceptCounter(w, 9)).toBe(true);
    expect(acceptCounter(w, 9)).toBe(false);
    expect(acceptCounter(w, 200)).toBe(true);
    expect(acceptCounter(w, 137)).toBe(true); // 63 behind
    expect(acceptCounter(w, 136)).toBe(false); // 64 behind
    expect(acceptCounter(w, 199)).toBe(true);
    expect(acceptCounter(w, 0xfffffffe)).toBe(true);
    expect(acceptCounter(w, 0xfffffffe - 63)).toBe(true);
  });
});

describe('the sealer', () => {
  const keys = { send: b(S.k_pd), recv: b(S.k_dp) };
  const fromDashcam = (k: Uint8Array, ctr: number, frame: number[]) => sealRaw(k, DIR_DP, ctr, frame);

  test('seals with a rising counter from 0 under k_pd, opens under k_dp, drops replays and bad tags', () => {
    const s = createSealer(keys);
    const w0 = s.seal([0x86, 1, 7, 0]) as Uint8Array;
    expect(toHex(w0)).toBe(V.sealed.find((v) => v.desc === 'COMMAND hello ctr 0')!.wire);
    expect(s.nextCounter()).toBe(1);
    const tx = fromDashcam(keys.recv, 0, [1, 1, 2, 3]);
    expect(s.open(tx)).toEqual({ ok: true, frame: [1, 1, 2, 3] });
    expect(s.open(tx)).toEqual({ ok: false, why: 'replay' });
    const bad = Uint8Array.from(fromDashcam(keys.recv, 1, [1, 1, 2, 3]));
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
    expect(s.open(bad)).toEqual({ ok: false, why: 'bad' });
    // the other direction's frame never opens on the phone
    expect(s.open(sealRaw(keys.send, DIR_PD, 5, [1, 1, 2, 3]))).toEqual({ ok: false, why: 'bad' });
    expect(s.open(new Uint8Array(21))).toEqual({ ok: false, why: 'bad' });
  });

  test('one counter per seal; the last counter is 2^32 - 2, after it the sealer is spent (the link ends)', () => {
    const s = createSealer(keys);
    for (let i = 0; i < 3; i++) expect(s.seal([0x86, 1, 7, 0])).not.toBe('spent');
    expect(s.nextCounter()).toBe(3);
    const end = createSealer(keys, { firstCounter: CTR_LAST });
    const w = end.seal([0x86, 1, 7, 0]);
    expect(w).not.toBe('spent');
    expect(openRaw(keys.send, DIR_PD, w as Uint8Array)?.ctr).toBe(0xfffffffe);
    expect(end.seal([0x86, 1, 7, 0])).toBe('spent');
    expect(end.seal([0x86, 1, 7, 0])).toBe('spent');
  });

  test('a re-handshake: new keys tried first once staged; old-key frames still open until the first new one after R_OK', () => {
    const s = createSealer(keys);
    const next = { send: new Uint8Array(16).fill(0x11), recv: new Uint8Array(16).fill(0x22) };
    expect(s.open(fromDashcam(keys.recv, 0, [2, 1, 0]))).toMatchObject({ ok: true });
    s.stage(next);
    // the dashcam switched when its FIN verified: frames under the new key open at once
    expect(s.open(fromDashcam(next.recv, 0, [2, 1, 1]))).toEqual({ ok: true, frame: [2, 1, 1] });
    // a frame sealed under the old key just before the switch still opens
    expect(s.open(fromDashcam(keys.recv, 1, [2, 1, 2]))).toEqual({ ok: true, frame: [2, 1, 2] });
    // still sending under the old key until R_OK
    expect(openRaw(keys.send, DIR_PD, s.seal([0x86, 1, 7, 0]) as Uint8Array)).not.toBeNull();
    s.commit();
    const w = s.seal([0x86, 1, 7, 0]) as Uint8Array;
    expect(openRaw(next.send, DIR_PD, w)?.ctr).toBe(0);
    expect(s.open(fromDashcam(keys.recv, 2, [2, 1, 3]))).toEqual({ ok: true, frame: [2, 1, 3] }); // old, before the first new after commit
    expect(s.open(fromDashcam(next.recv, 1, [2, 1, 4]))).toEqual({ ok: true, frame: [2, 1, 4] });
    // the old key is gone now
    expect(s.open(fromDashcam(keys.recv, 3, [2, 1, 5]))).toEqual({ ok: false, why: 'bad' });
  });

  test('two re-handshakes in a row with no frame between: the second starts from the first one’s keys', () => {
    const s = createSealer(keys);
    const k2 = { send: new Uint8Array(16).fill(0x55), recv: new Uint8Array(16).fill(0x66) };
    const k3 = { send: new Uint8Array(16).fill(0x77), recv: new Uint8Array(16).fill(0x88) };
    s.stage(k2);
    s.commit();
    s.stage(k3);
    // the dashcam is on k2 until the second FIN verifies: its frames open
    expect(s.open(fromDashcam(k2.recv, 0, [2, 1, 0]))).toEqual({ ok: true, frame: [2, 1, 0] });
    expect(openRaw(k2.send, DIR_PD, s.seal([0x86, 1, 7, 0]) as Uint8Array)?.ctr).toBe(0);
    s.commit();
    expect(s.open(fromDashcam(k3.recv, 0, [2, 1, 1]))).toEqual({ ok: true, frame: [2, 1, 1] });
    expect(s.open(fromDashcam(keys.recv, 5, [2, 1, 2]))).toEqual({ ok: false, why: 'bad' });
  });

  test('an aborted re-handshake drops the staged keys and keeps the current ones', () => {
    const s = createSealer(keys);
    const next = { send: new Uint8Array(16).fill(0x33), recv: new Uint8Array(16).fill(0x44) };
    s.stage(next);
    s.abort();
    expect(s.open(fromDashcam(next.recv, 0, [2, 1, 0]))).toEqual({ ok: false, why: 'bad' });
    expect(s.open(fromDashcam(keys.recv, 0, [2, 1, 0]))).toEqual({ ok: true, frame: [2, 1, 0] });
    expect(openRaw(keys.send, DIR_PD, s.seal([0x86, 1, 7, 0]) as Uint8Array)?.ctr).toBe(0);
    s.commit(); // nothing staged: no change
    expect(openRaw(keys.send, DIR_PD, s.seal([0x86, 1, 7, 0]) as Uint8Array)?.ctr).toBe(1);
  });
});

describe('the v2 INFO vectors', () => {
  test('decode with their Nc', () => {
    for (const v of V.info.valid) {
      const i = decodeInfo(fromHex(v.hex))!;
      expect(i.dashcamId).toBe(v.fields.mac);
      expect(i.bondCount).toBe(v.fields.bond_count);
    }
  });
});


// ——— link v3 ———

interface V3Auth {
  pair: {
    a: Hex; A: Hex; b: Hex; B: Hex; nc: Hex; np: Hex; nd: Hex; id_p: Hex; mac: Hex; pair_open: Hex; Z: Hex; T_pair: Hex; K_pair: Hex; k_conf: Hex;
    proof_d: Hex; proof_p: Hex; pair_resp: Hex; pair_fin: Hex;
    replace: { prev_id: Hex; prev_K_pair: Hex; id_p: Hex; prev_proof: Hex; pair_open: Hex; expect: string };
    bad_key: { A: Hex; pair_open: Hex; expect: string };
  };
  session_after_pair: {
    K_pair: Hex; id_p: Hex; mac: Hex; nc: Hex; np: Hex; nd: Hex; bid: Hex; session_req: Hex; T_s: Hex; k_dp: Hex; k_pd: Hex; k_conf: Hex; session_resp: Hex; session_fin: Hex;
  };
  results: { code: number; name: string; hex: Hex }[];
  view: {
    sealed: { desc: string; dir: number; key: 'k_dp'; ctr: number; record: Hex; wire: Hex }[];
    sealed_invalid: { desc: string; dir: number; key: 'k_dp'; wire: Hex; accepted?: number[]; expect: 'bad' | 'replay' }[];
  };
}
const V3 = (vectors as unknown as { v3: V3Auth }).v3;
const P3 = V3.pair;
const S3 = V3.session_after_pair;

describe('pairing (link v3: PAIR_OPEN, no code)', () => {
  const base = { mac: b(P3.mac), nc: b(P3.nc), idP: b(P3.id_p), a: b(P3.a), np: b(P3.np) };

  test('PAIR_OPEN, the keys from PAIR_RESP (HKDF salted with Nc || Nd), the proofs and PAIR_FIN', () => {
    const open = pairOpen(base);
    expect(toHex(open.A)).toBe(P3.A);
    expect(toHex(open.bytes)).toBe(P3.pair_open);
    expect(open.bytes).toHaveLength(PAIR_OPEN_LEN);
    const resp = parseAuthRecord(b(P3.pair_resp));
    if (resp.kind !== 'pair_resp') throw new Error('vector');
    expect(toHex(resp.B)).toBe(P3.B);
    expect(toHex(resp.Nd)).toBe(P3.nd);
    const k = pairKeysV3({ mac: base.mac, nc: base.nc, open: open.bytes, a: base.a, B: resp.B, Nd: resp.Nd })!;
    expect(toHex(x25519Shared(b(P3.a), b(P3.B))!)).toBe(P3.Z);
    expect(toHex(k.T_pair)).toBe(P3.T_pair);
    expect(toHex(k.K_pair)).toBe(P3.K_pair);
    expect(toHex(k.k_conf)).toBe(P3.k_conf);
    expect(toHex(k.proofD)).toBe(P3.proof_d);
    expect(proofOk(k.proofD, resp.proofD)).toBe(true);
    expect(toHex(k.proofP)).toBe(P3.proof_p);
    expect(toHex(pairFin(k.proofP))).toBe(P3.pair_fin);
  });

  test('a changed B or Nd fails the dashcam proof (key confirmation); a refused B gives no keys', () => {
    const open = pairOpen(base);
    const resp = parseAuthRecord(b(P3.pair_resp));
    if (resp.kind !== 'pair_resp') throw new Error('vector');
    const nd = Uint8Array.from(resp.Nd);
    nd[0] = nd[0]! ^ 1;
    const k = pairKeysV3({ mac: base.mac, nc: base.nc, open: open.bytes, a: base.a, B: resp.B, Nd: nd })!;
    expect(proofOk(k.proofD, resp.proofD)).toBe(false);
    const other = pairKeysV3({ mac: base.mac, nc: base.nc, open: open.bytes, a: base.a, B: x25519Public(new Uint8Array(32).fill(5)), Nd: resp.Nd })!;
    expect(proofOk(other.proofD, resp.proofD)).toBe(false);
    expect(pairKeysV3({ mac: base.mac, nc: base.nc, open: open.bytes, a: base.a, B: new Uint8Array(32), Nd: resp.Nd })).toBeNull();
    expect(() => pairKeysV3({ mac: base.mac, nc: base.nc, open: open.bytes.slice(0, 81), a: base.a, B: resp.B, Nd: resp.Nd })).toThrow();
  });

  test('replacing a record: prev_proof under its key, bound to the new id and this Nc', () => {
    const r = P3.replace;
    const open = pairOpen({ ...base, idP: b(r.id_p), prev: { id: b(r.prev_id), kPair: b(r.prev_K_pair) } });
    expect(toHex(open.bytes)).toBe(r.pair_open);
    expect(toHex(open.bytes.slice(18, 34))).toBe(r.prev_proof);
  });

  test('a low-order A: the vector’s PAIR_OPEN, which the dashcam answers R_BAD_KEY', () => {
    const bk = P3.bad_key;
    const bytes = b(bk.pair_open);
    expect(bytes).toHaveLength(PAIR_OPEN_LEN);
    expect(bytes[0]).toBe(AUTH_MSG.PAIR_OPEN);
    expect(toHex(bytes.slice(34, 66))).toBe(bk.A);
    expect(x25519Shared(b(P3.b), b(bk.A))).toBeNull();
    expect(bk.expect).toBe('R_BAD_KEY');
  });

  test('inputs of the wrong size and a zero id are refused before anything is built', () => {
    expect(() => pairOpen({ ...base, idP: new Uint8Array(8) })).toThrow();
    expect(() => pairOpen({ ...base, nc: new Uint8Array(15) })).toThrow();
    expect(() => pairOpen({ ...base, np: new Uint8Array(17) })).toThrow();
  });

  test('the session right after a pairing, under its new key (the v2 session labels)', () => {
    expect(S3.K_pair).toBe(P3.K_pair);
    expect(toHex(sessionRequest(b(S3.K_pair), b(S3.mac), b(S3.nc), b(S3.np)))).toBe(S3.session_req);
    expect(toHex(blindedId(b(S3.K_pair), b(S3.mac), b(S3.nc)))).toBe(S3.bid);
    const k = sessionKeys(b(S3.K_pair), b(S3.mac), b(S3.id_p), b(S3.np), b(S3.nd));
    expect([toHex(k.T_s), toHex(k.k_dp), toHex(k.k_pd), toHex(k.k_conf)]).toEqual([S3.T_s, S3.k_dp, S3.k_pd, S3.k_conf]);
    const resp = parseAuthRecord(b(S3.session_resp));
    if (resp.kind !== 'session_resp') throw new Error('vector');
    expect(proofOk(k.proofD, resp.proofD)).toBe(true);
    expect(toHex(sessionFin(k.proofP))).toBe(S3.session_fin);
  });

  test.each(V3.results)('RESULT $name ($code)', (r) => {
    expect(toHex(resultRecord(r.code))).toBe(r.hex);
    expect(parseAuthRecord(b(r.hex))).toEqual({ kind: 'result', code: r.code });
    expect((R as Record<string, number>)[r.name.slice(2)]).toBe(r.code);
  });
});

describe('VIEW records (direction 3)', () => {
  const kdp = b(S3.k_dp);

  test.each(V3.view.sealed)('$desc seals to the vector and opens back', (v) => {
    expect(v.dir).toBe(DIR_VIEW);
    expect(toHex(sealView(kdp, v.ctr, b(v.record)))).toBe(v.wire);
    const o = openRaw(kdp, DIR_VIEW, b(v.wire))!;
    expect(o.ctr).toBe(v.ctr);
    expect(toHex(o.frame)).toBe(v.record);
  });

  test.each(V3.view.sealed_invalid)('$desc: $expect', (v) => {
    const w = newWindow();
    for (const c of v.accepted ?? []) expect(acceptCounter(w, c)).toBe(true);
    const o = openRaw(kdp, DIR_VIEW, b(v.wire));
    if (v.expect === 'bad') {
      expect(o).toBeNull();
      return;
    }
    expect(o).not.toBeNull();
    expect(acceptCounter(w, o!.ctr)).toBe(false);
  });

  test('a record is 1-488 bytes', () => {
    expect(sealView(kdp, 0, new Uint8Array(VIEW_RECORD_MAX))).toHaveLength(VIEW_RECORD_MAX + 20);
    expect(() => sealView(kdp, 0, new Uint8Array(VIEW_RECORD_MAX + 1))).toThrow();
    expect(() => sealView(kdp, 0, [])).toThrow();
  });

  test('the sealer opens VIEW records under its receive key with a replay window of their own; a TX frame never opens as VIEW, nor VIEW as TX', () => {
    const s = createSealer({ send: b(S3.k_pd), recv: kdp });
    const first = V3.view.sealed[0]!;
    // a TX frame at the same counter does not use up the VIEW counter
    expect(s.open(sealRaw(kdp, DIR_DP, first.ctr, [1, 1, 2, 3]))).toEqual({ ok: true, frame: [1, 1, 2, 3] });
    expect(s.openView(b(first.wire))).toEqual({ ok: true, frame: Array.from(b(first.record)) });
    expect(s.openView(b(first.wire))).toEqual({ ok: false, why: 'replay' });
    expect(s.open(b(first.wire))).toEqual({ ok: false, why: 'bad' });
    expect(s.openView(sealRaw(kdp, DIR_DP, 9, [1, 1, 2, 3]))).toEqual({ ok: false, why: 'bad' });
    expect(s.openView(new Uint8Array(21))).toEqual({ ok: false, why: 'bad' });
    for (const v of V3.view.sealed.slice(1)) expect(s.openView(b(v.wire)).ok).toBe(true);
  });
});

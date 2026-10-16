// The link v2 handshakes and sealed frames, phone side (docs/BLE_PROTOCOL.md §2.2, §3.3). Pure:
// bytes in, bytes out; randomness is passed in, so the shared vectors reproduce every byte.
//
// AUTH (0006) carries the handshakes. Every well-formed write is answered ATT 0 and its verdict is
// the AUTH read value: `[0x00]` pending, PAIR_RESP `[0x90][2][B 32][Nd 16][proof_d 16]`,
// SESSION_RESP `[0xA0][2][Nd 16][proof_d 16]` or RESULT `[0xE0][2][code]`.
//
// Pairing: PAIR_REQ `[0x10][2][id_p 8][prev_id 8][prev_proof 16][A 32][Np 16][tag 16]` with
//   tag        = HMAC(code, "DPv2 pair-req" || mac || Nc || id_p || prev_id || prev_proof || A || Np)[0..16]
//   prev_proof = HMAC(K_pair of prev_id, "DPv2 replace" || mac || Nc || id_p)[0..16] (zero for none)
//   T_pair = SHA-256("DPv2 pair" || mac || Nc || id_p || prev_id || prev_proof || A || Np || B || Nd)
//   OKM = HKDF(salt = code, IKM = X25519(a, B), info = T_pair, 64): K_pair = OKM[0..32], k_conf = OKM[32..64]
//   proof_d = HMAC(k_conf, "DPv2 dashcam" || T_pair)[0..16], proof_p = HMAC(k_conf, "DPv2 phone" || T_pair)[0..16]
//   PAIR_FIN `[0x11][2][proof_p 16]`.
// Session: SESSION_REQ `[0x20][2][bid 8][Np 16]`, bid = HMAC(K_pair, "DPv2 id" || mac || Nc)[0..8];
//   T_s = SHA-256("DPv2 session" || mac || id_p || Np || Nd); OKM = HKDF(salt = Np || Nd, IKM = K_pair,
//   info = T_s, 48): k_dp, k_pd, k_conf; the proofs as above over T_s; SESSION_FIN `[0x21][2][proof_p 16]`.
// Sealed frame: `[ctr u32 LE][AES-128-GCM of the frame][tag 16]`, nonce `[dir][0 x 7][ctr u32 LE]`,
//   aad `[0x02][dir]`; dir 1 dashcam -> phone (k_dp), 2 phone -> dashcam (k_pd).
import { concat, ctEqual, gcmOpen, gcmSeal, hkdfSha256, hmacSha256, sha256, utf8, wipe, x25519Public, x25519Shared } from './crypto';

export const AUTH_VERSION = 2;
export const AUTH_MSG = { PAIR_REQ: 0x10, PAIR_FIN: 0x11, SESSION_REQ: 0x20, SESSION_FIN: 0x21 } as const;
export const AUTH_RECORD = { PENDING: 0x00, PAIR_RESP: 0x90, SESSION_RESP: 0xa0, RESULT: 0xe0 } as const;

/** RESULT codes (never ATT statuses). */
export const R = {
  OK: 0x00,
  NOT_NOW: 0x01,
  UNKNOWN_PHONE: 0x02,
  BUSY: 0x03,
  WRONG_PROOF: 0x04,
  WRONG_CODE: 0x05,
  UNKEYED: 0x06,
  ID_IN_USE: 0x07,
  STORE_FAILED: 0x08,
  MTU: 0x09,
} as const;
export type ResultCode = (typeof R)[keyof typeof R];

export const PAIR_REQ_LEN = 98;
export const PAIR_RESP_LEN = 66;
export const SESSION_REQ_LEN = 26;
export const SESSION_RESP_LEN = 34;
export const FIN_LEN = 18;
export const RESULT_LEN = 3;
/** ADD_PHONE `[0x88][1][code 16]`: a frame of the sealed link (RX), not of AUTH. */
export const ADD_PHONE_TYPE = 0x88;
export const ADD_PHONE_LEN = 18;

/** dashcam -> phone, phone -> dashcam */
export const DIR_DP = 0x01;
export const DIR_PD = 0x02;
export const SEAL_OVERHEAD = 20;
export const SEALED_MIN = 22;
export const SEALED_MAX = 40;
export const REPLAY_WINDOW = 64;
/** The last counter a sender may use: at 2^32 - 1 it ends the connection instead. */
export const CTR_LAST = 0xfffffffe;

const LABEL = {
  pairReq: utf8('DPv2 pair-req'),
  replace: utf8('DPv2 replace'),
  pair: utf8('DPv2 pair'),
  dashcam: utf8('DPv2 dashcam'),
  phone: utf8('DPv2 phone'),
  id: utf8('DPv2 id'),
  session: utf8('DPv2 session'),
};

const mac16 = (key: Uint8Array, ...parts: ArrayLike<number>[]): Uint8Array => hmacSha256(key, ...parts).slice(0, 16);

function fixed(name: string, b: ArrayLike<number>, n: number): Uint8Array {
  if (b.length !== n) throw new Error(`${name} must be ${n} bytes (got ${b.length})`);
  return Uint8Array.from(b);
}

// ——— the AUTH read value ———

export type AuthRecord =
  | { kind: 'pending' }
  | { kind: 'pair_resp'; B: Uint8Array; Nd: Uint8Array; proofD: Uint8Array }
  | { kind: 'session_resp'; Nd: Uint8Array; proofD: Uint8Array }
  | { kind: 'result'; code: number }
  /** anything else: a transport fault, never a verdict */
  | { kind: 'bad' };

export function parseAuthRecord(b: ArrayLike<number>): AuthRecord {
  const v = Uint8Array.from(b);
  if (v.length === 0) return { kind: 'bad' };
  switch (v[0]) {
    case AUTH_RECORD.PENDING:
      return v.length === 1 ? { kind: 'pending' } : { kind: 'bad' };
    case AUTH_RECORD.PAIR_RESP:
      return v.length === PAIR_RESP_LEN && v[1] === AUTH_VERSION ? { kind: 'pair_resp', B: v.slice(2, 34), Nd: v.slice(34, 50), proofD: v.slice(50, 66) } : { kind: 'bad' };
    case AUTH_RECORD.SESSION_RESP:
      return v.length === SESSION_RESP_LEN && v[1] === AUTH_VERSION ? { kind: 'session_resp', Nd: v.slice(2, 18), proofD: v.slice(18, 34) } : { kind: 'bad' };
    case AUTH_RECORD.RESULT:
      return v.length === RESULT_LEN && v[1] === AUTH_VERSION ? { kind: 'result', code: v[2]! } : { kind: 'bad' };
    default:
      return { kind: 'bad' };
  }
}

/** The RESULT record of a code (the dashcam's side; tests and vectors). */
export const resultRecord = (code: number): Uint8Array => Uint8Array.from([AUTH_RECORD.RESULT, AUTH_VERSION, code & 0xff]);

// ——— pairing ———

export interface PairInputs {
  /** the label code S or the window's one-time code S1 (16 bytes) */
  code: Uint8Array;
  /** INFO's 6 mac bytes, most significant first */
  mac: ArrayLike<number>;
  /** the link's Nc, from the INFO read just before */
  nc: ArrayLike<number>;
  /** this phone's new id (8 bytes, not all zero) */
  idP: ArrayLike<number>;
  /** the phone's X25519 private scalar (32 bytes) */
  a: ArrayLike<number>;
  np: ArrayLike<number>;
  /** a record of this phone on that dashcam to replace: its id and its K_pair (proven by prev_proof) */
  prev?: { id: ArrayLike<number>; kPair: ArrayLike<number> } | null;
}

export interface PairRequest {
  bytes: Uint8Array;
  A: Uint8Array;
}

export function pairRequest(i: PairInputs): PairRequest {
  const mac = fixed('mac', i.mac, 6);
  const nc = fixed('Nc', i.nc, 16);
  const idP = fixed('id_p', i.idP, 8);
  if (idP.every((b) => b === 0)) throw new Error('id_p must not be zero');
  const code = fixed('code', i.code, 16);
  const np = fixed('Np', i.np, 16);
  const A = x25519Public(fixed('a', i.a, 32));
  const prevId = i.prev ? fixed('prev_id', i.prev.id, 8) : new Uint8Array(8);
  const prevProof = i.prev ? mac16(fixed('prev K_pair', i.prev.kPair, 32), LABEL.replace, mac, nc, idP) : new Uint8Array(16);
  const body = concat(idP, prevId, prevProof, A, np);
  const tag = mac16(code, LABEL.pairReq, mac, nc, body);
  return { bytes: concat([AUTH_MSG.PAIR_REQ, AUTH_VERSION], body, tag), A };
}

export interface PairKeys {
  T_pair: Uint8Array;
  K_pair: Uint8Array;
  k_conf: Uint8Array;
  proofD: Uint8Array;
  proofP: Uint8Array;
}

/**
 * The keys of a pairing from the phone's request and the dashcam's PAIR_RESP, or null when the
 * dashcam's key is refused (a low-order point). The caller checks `proofD` against the response.
 */
export function pairKeys(i: { code: Uint8Array; mac: ArrayLike<number>; nc: ArrayLike<number>; req: Uint8Array; a: ArrayLike<number>; B: Uint8Array; Nd: Uint8Array }): PairKeys | null {
  const z = x25519Shared(fixed('a', i.a, 32), fixed('B', i.B, 32));
  if (!z) return null;
  if (i.req.length !== PAIR_REQ_LEN) throw new Error('PAIR_REQ must be 98 bytes');
  const t = sha256(LABEL.pair, fixed('mac', i.mac, 6), fixed('Nc', i.nc, 16), i.req.slice(2, 82), i.B, fixed('Nd', i.Nd, 16));
  const okm = hkdfSha256(fixed('code', i.code, 16), z, t, 64);
  wipe(z);
  const K_pair = okm.slice(0, 32);
  const k_conf = okm.slice(32, 64);
  wipe(okm);
  return { T_pair: t, K_pair, k_conf, proofD: mac16(k_conf, LABEL.dashcam, t), proofP: mac16(k_conf, LABEL.phone, t) };
}

export const pairFin = (proofP: Uint8Array): Uint8Array => concat([AUTH_MSG.PAIR_FIN, AUTH_VERSION], fixed('proof_p', proofP, 16));

// ——— session ———

/** The blinded session id: never the same twice for one phone, unreadable without K_pair. */
export const blindedId = (kPair: ArrayLike<number>, mac: ArrayLike<number>, nc: ArrayLike<number>): Uint8Array =>
  hmacSha256(fixed('K_pair', kPair, 32), LABEL.id, fixed('mac', mac, 6), fixed('Nc', nc, 16)).slice(0, 8);

export const sessionRequest = (kPair: ArrayLike<number>, mac: ArrayLike<number>, nc: ArrayLike<number>, np: ArrayLike<number>): Uint8Array =>
  concat([AUTH_MSG.SESSION_REQ, AUTH_VERSION], blindedId(kPair, mac, nc), fixed('Np', np, 16));

export interface SessionKeys {
  T_s: Uint8Array;
  k_dp: Uint8Array;
  k_pd: Uint8Array;
  k_conf: Uint8Array;
  proofD: Uint8Array;
  proofP: Uint8Array;
}

export function sessionKeys(kPair: ArrayLike<number>, mac: ArrayLike<number>, idP: ArrayLike<number>, np: ArrayLike<number>, nd: ArrayLike<number>): SessionKeys {
  const npB = fixed('Np', np, 16);
  const ndB = fixed('Nd', nd, 16);
  const t = sha256(LABEL.session, fixed('mac', mac, 6), fixed('id_p', idP, 8), npB, ndB);
  const okm = hkdfSha256(concat(npB, ndB), fixed('K_pair', kPair, 32), t, 48);
  const k_conf = okm.slice(32, 48);
  const out = { T_s: t, k_dp: okm.slice(0, 16), k_pd: okm.slice(16, 32), k_conf, proofD: mac16(k_conf, LABEL.dashcam, t), proofP: mac16(k_conf, LABEL.phone, t) };
  wipe(okm);
  return out;
}

export const sessionFin = (proofP: Uint8Array): Uint8Array => concat([AUTH_MSG.SESSION_FIN, AUTH_VERSION], fixed('proof_p', proofP, 16));

/** The dashcam's proof checked in constant time. */
export const proofOk = (expected: Uint8Array, got: Uint8Array): boolean => got.length === 16 && ctEqual(expected, got);

// ——— ADD_PHONE ———

/** ADD_PHONE `[0x88][1][code 16]`, the one-time code for the window it opens (sent sealed). */
export const addPhoneFrame = (S1: ArrayLike<number>): number[] => [ADD_PHONE_TYPE, 1, ...fixed('one-time code', S1, 16)];

// ——— sealed frames ———

function nonceOf(dir: number, ctr: number): Uint8Array {
  const n = new Uint8Array(12);
  n[0] = dir;
  n[8] = ctr & 0xff;
  n[9] = (ctr >>> 8) & 0xff;
  n[10] = (ctr >>> 16) & 0xff;
  n[11] = (ctr >>> 24) & 0xff;
  return n;
}

const aadOf = (dir: number): Uint8Array => Uint8Array.from([AUTH_VERSION, dir]);

/** Seal one frame (2-20 bytes) at `ctr`. */
export function sealRaw(key: Uint8Array, dir: number, ctr: number, frame: ArrayLike<number>): Uint8Array {
  if (frame.length < 2 || frame.length > 20) throw new Error('a frame is 2-20 bytes');
  const head = nonceOf(dir, ctr).slice(8, 12);
  return concat(head, gcmSeal(key, nonceOf(dir, ctr), aadOf(dir), Uint8Array.from(frame)));
}

/** Open a sealed frame: its counter and frame, or null when it is short or its tag does not verify. */
export function openRaw(key: Uint8Array, dir: number, wire: ArrayLike<number>): { ctr: number; frame: Uint8Array } | null {
  if (wire.length < SEALED_MIN) return null;
  const w = Uint8Array.from(wire);
  const ctr = (w[0]! | (w[1]! << 8) | (w[2]! << 16) | (w[3]! << 24)) >>> 0;
  const frame = gcmOpen(key, nonceOf(dir, ctr), aadOf(dir), w.slice(4));
  return frame ? { ctr, frame } : null;
}

/** A receiver's 64-frame replay window (the firmware's rule, after the tag). */
export interface ReplayWindow {
  have: boolean;
  hi: number;
  /** bit d: counter hi - d seen */
  map: bigint;
}

export const newWindow = (): ReplayWindow => ({ have: false, hi: 0, map: 0n });

/** Accept `ctr` into the window (true) or refuse it as a replay (false). Mutates the window only on accept. */
export function acceptCounter(w: ReplayWindow, ctr: number): boolean {
  if (!w.have) {
    w.have = true;
    w.hi = ctr;
    w.map = 1n;
    return true;
  }
  if (ctr > w.hi) {
    const d = ctr - w.hi;
    w.map = d >= REPLAY_WINDOW ? 1n : ((w.map << BigInt(d)) | 1n) & 0xffffffffffffffffn;
    w.hi = ctr;
    return true;
  }
  const d = w.hi - ctr;
  if (d === 0 || d > REPLAY_WINDOW - 1 || ((w.map >> BigInt(d)) & 1n) === 1n) return false;
  w.map |= 1n << BigInt(d);
  return true;
}

export interface SealerKeys {
  /** the phone's send key (k_pd) */
  send: Uint8Array;
  /** the phone's receive key (k_dp) */
  recv: Uint8Array;
}

export type OpenResult = { ok: true; frame: number[] } | { ok: false; why: 'bad' | 'replay' };

export interface Sealer {
  /** Seal a frame with the next counter, or 'spent' when every counter has been used (end the link). */
  seal(frame: ArrayLike<number>): Uint8Array | 'spent';
  open(wire: ArrayLike<number>): OpenResult;
  /**
   * A re-handshake's keys once the dashcam's proof checked: received frames try them first (the
   * dashcam switches when its FIN verifies) and the current key after; sending stays on the current.
   */
  stage(next: SealerKeys): void;
  /** R_OK read: send with the new key from counter 0; the old receive key stays for frames sealed before the switch, until one opens under the new. */
  commit(): void;
  /** R_WRONG_PROOF or no RESULT: the staged keys go. */
  abort(): void;
  /** the next send counter (tests) */
  nextCounter(): number;
  dispose(): void;
}

interface RecvKey {
  key: Uint8Array;
  window: ReplayWindow;
}

/**
 * The phone's sealer for one session: k_pd out (dir 2), k_dp in (dir 1). `firstCounter` (tests only,
 * as the firmware's debug counter) starts the send counter elsewhere than 0.
 */
export function createSealer(keys: SealerKeys, opts: { firstCounter?: number } = {}): Sealer {
  let send: Uint8Array = Uint8Array.from(keys.send);
  let ctr = opts.firstCounter ?? 0;
  let recv: RecvKey = { key: Uint8Array.from(keys.recv), window: newWindow() };
  /** a staged or committed newer receive key, tried first */
  let newer: RecvKey | null = null;
  let staged: SealerKeys | null = null;
  let committed = false;

  function tryKey(k: RecvKey, wire: ArrayLike<number>): OpenResult | null {
    const o = openRaw(k.key, DIR_DP, wire);
    if (!o) return null;
    if (!acceptCounter(k.window, o.ctr)) return { ok: false, why: 'replay' };
    return { ok: true, frame: Array.from(o.frame) };
  }

  return {
    seal(frame) {
      if (ctr > CTR_LAST) return 'spent';
      const out = sealRaw(send, DIR_PD, ctr, frame);
      ctr += 1;
      return out;
    },
    open(wire) {
      if (newer) {
        const r = tryKey(newer, wire);
        if (r) {
          if (r.ok && committed) {
            // The dashcam is on the new keys: the old receive key is no longer needed.
            wipe(recv.key);
            recv = newer;
            newer = null;
            committed = false;
          }
          return r;
        }
      }
      return tryKey(recv, wire) ?? { ok: false, why: 'bad' };
    },
    stage(next) {
      if (newer && committed) {
        // An earlier re-handshake's R_OK was read: the dashcam is on its keys, which become current.
        wipe(recv.key);
        recv = newer;
      } else if (newer) {
        wipe(newer.key);
      }
      if (staged) {
        wipe(staged.send);
        wipe(staged.recv);
      }
      staged = { send: Uint8Array.from(next.send), recv: Uint8Array.from(next.recv) };
      newer = { key: Uint8Array.from(next.recv), window: newWindow() };
      committed = false;
    },
    commit() {
      if (!staged) return;
      wipe(send);
      send = staged.send;
      ctr = 0;
      staged = null;
      committed = true;
    },
    abort() {
      if (staged) {
        wipe(staged.send);
        wipe(staged.recv);
      }
      staged = null;
      if (newer && !committed) {
        wipe(newer.key);
        newer = null;
      }
    },
    nextCounter: () => ctr,
    dispose() {
      wipe(send);
      wipe(recv.key);
      if (newer) wipe(newer.key);
      if (staged) {
        wipe(staged.send);
        wipe(staged.recv);
      }
      newer = null;
      staged = null;
    },
  };
}

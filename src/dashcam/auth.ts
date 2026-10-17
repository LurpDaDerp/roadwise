// The link v3 handshakes and sealed frames, phone side (docs/BLE_PROTOCOL.md §2.2, §3.3, §3.4).
// Pure: bytes in, bytes out; randomness is passed in, so the shared vectors reproduce every byte.
//
// AUTH (0006) carries the handshakes. Every well-formed write is answered ATT 0 and its verdict is
// the AUTH read value: `[0x00]` pending, PAIR_RESP `[0x90][2][B 32][Nd 16][proof_d 16]`,
// SESSION_RESP `[0xA0][2][Nd 16][proof_d 16]` or RESULT `[0xE0][2][code]`.
//
// Pairing, with no shared secret: PAIR_OPEN `[0x12][2][id_p 8][prev_id 8][prev_proof 16][A 32][Np 16]` with
//   prev_proof = HMAC(K_pair of prev_id, "DPv3 replace" || mac || Nc || id_p || prev_id || A || Np)[0..16] (zero for
//   none): the rest of the request in its order, so it proves that one request only (a relay cannot carry it to its own key)
//   T_pair = SHA-256("DPv3 pair" || mac || Nc || PAIR_OPEN[2..82] || B || Nd)
//   OKM = HKDF(salt = Nc || Nd, IKM = X25519(a, B), info = T_pair, 64): K_pair = OKM[0..32], k_conf = OKM[32..64]
//   proof_d = HMAC(k_conf, "DPv3 dashcam" || T_pair)[0..16], proof_p = HMAC(k_conf, "DPv3 phone" || T_pair)[0..16]
//   PAIR_FIN `[0x11][2][proof_p 16]`. The proofs confirm the key; they do not tell which device answered.
// Session: SESSION_REQ `[0x20][2][bid 8][Np 16]`, bid = HMAC(K_pair, "DPv2 id" || mac || Nc)[0..8];
//   T_s = SHA-256("DPv2 session" || mac || id_p || Np || Nd); OKM = HKDF(salt = Np || Nd, IKM = K_pair,
//   info = T_s, 48): k_dp, k_pd, k_conf; the proofs as above over T_s ("DPv2" labels);
//   SESSION_FIN `[0x21][2][proof_p 16]`.
// Sealed frame: `[ctr u32 LE][AES-128-GCM of the frame][tag 16]`, nonce `[dir][0 x 7][ctr u32 LE]`,
//   aad `[0x02][dir]`; dir 1 dashcam -> phone (k_dp), 2 phone -> dashcam (k_pd), 3 the aiming
//   picture's VIEW records (k_dp, 1-488 bytes, a counter and replay window of their own).
import { concat, ctEqual, gcmOpen, gcmSeal, hkdfSha256, hmacSha256, sha256, utf8, wipe, x25519Public, x25519Shared } from './crypto';

export const AUTH_VERSION = 2;
export const AUTH_MSG = { PAIR_FIN: 0x11, PAIR_OPEN: 0x12, SESSION_REQ: 0x20, SESSION_FIN: 0x21 } as const;
export const AUTH_RECORD = { PENDING: 0x00, PAIR_RESP: 0x90, SESSION_RESP: 0xa0, RESULT: 0xe0 } as const;

/** RESULT codes (never ATT statuses). */
export const R = {
  OK: 0x00,
  NOT_NOW: 0x01,
  UNKNOWN_PHONE: 0x02,
  BUSY: 0x03,
  WRONG_PROOF: 0x04,
  ID_IN_USE: 0x07,
  STORE_FAILED: 0x08,
  MTU: 0x09,
  /** PAIR_OPEN's `A` refused (a low-order point): the connection is condemned */
  BAD_KEY: 0x0a,
  /** SETUP_RESULT only: the setup hold ran out with its phone connected */
  EXPIRED: 0x0b,
} as const;
export type ResultCode = (typeof R)[keyof typeof R];

export const PAIR_OPEN_LEN = 82;
export const PAIR_RESP_LEN = 66;
export const SESSION_REQ_LEN = 26;
export const SESSION_RESP_LEN = 34;
export const FIN_LEN = 18;
export const RESULT_LEN = 3;

/** dashcam -> phone, phone -> dashcam, the aiming picture's VIEW records (dashcam -> phone) */
export const DIR_DP = 0x01;
export const DIR_PD = 0x02;
export const DIR_VIEW = 0x03;
export const SEAL_OVERHEAD = 20;
export const SEALED_MIN = 22;
export const SEALED_MAX = 40;
/** The longest VIEW record (MTU 512 − 3 − 20 − 1, the firmware's limit). */
export const VIEW_RECORD_MAX = 488;
export const REPLAY_WINDOW = 64;
/** The last counter a sender may use: at 2^32 - 1 it ends the connection instead. */
export const CTR_LAST = 0xfffffffe;

/** The session's labels (link v2's, unchanged in v3). */
const LABEL = {
  dashcam: utf8('DPv2 dashcam'),
  phone: utf8('DPv2 phone'),
  id: utf8('DPv2 id'),
  session: utf8('DPv2 session'),
};

const LABEL_V3 = {
  replace: utf8('DPv3 replace'),
  pair: utf8('DPv3 pair'),
  dashcam: utf8('DPv3 dashcam'),
  phone: utf8('DPv3 phone'),
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

/** A PAIR_OPEN and the phone's public key in it. */
export interface PairRequest {
  bytes: Uint8Array;
  A: Uint8Array;
}

export interface PairKeys {
  T_pair: Uint8Array;
  K_pair: Uint8Array;
  k_conf: Uint8Array;
  proofD: Uint8Array;
  proofP: Uint8Array;
}

export const pairFin = (proofP: Uint8Array): Uint8Array => concat([AUTH_MSG.PAIR_FIN, AUTH_VERSION], fixed('proof_p', proofP, 16));

export interface PairOpenInputs {
  /** INFO's 6 mac bytes, most significant first */
  mac: ArrayLike<number>;
  /** the link's Nc, from the INFO read just before */
  nc: ArrayLike<number>;
  /** this phone's new id (8 bytes, not all zero) */
  idP: ArrayLike<number>;
  /** the phone's X25519 private scalar (32 bytes) */
  a: ArrayLike<number>;
  /** its public key when already computed; else computed here */
  A?: ArrayLike<number>;
  np: ArrayLike<number>;
  /** a record of this phone on that dashcam to replace: its id and its K_pair (proven by prev_proof) */
  prev?: { id: ArrayLike<number>; kPair: ArrayLike<number> } | null;
}

/** PAIR_OPEN (82 bytes): one tap, no code. */
export function pairOpen(i: PairOpenInputs): PairRequest {
  const mac = fixed('mac', i.mac, 6);
  const nc = fixed('Nc', i.nc, 16);
  const idP = fixed('id_p', i.idP, 8);
  if (idP.every((b) => b === 0)) throw new Error('id_p must not be zero');
  const np = fixed('Np', i.np, 16);
  const A = i.A ? fixed('A', i.A, 32) : x25519Public(fixed('a', i.a, 32));
  const prevId = i.prev ? fixed('prev_id', i.prev.id, 8) : new Uint8Array(8);
  const prevProof = i.prev ? mac16(fixed('prev K_pair', i.prev.kPair, 32), LABEL_V3.replace, mac, nc, idP, prevId, A, np) : new Uint8Array(16);
  return { bytes: concat([AUTH_MSG.PAIR_OPEN, AUTH_VERSION], idP, prevId, prevProof, A, np), A };
}

/**
 * The keys of a v3 pairing from the phone's PAIR_OPEN and the dashcam's PAIR_RESP, or null when the
 * dashcam's key is refused (a low-order point). `nc` is the Nc the PAIR_OPEN was made over. The
 * caller checks `proofD` against the response.
 */
export function pairKeysV3(i: { mac: ArrayLike<number>; nc: ArrayLike<number>; open: Uint8Array; a: ArrayLike<number>; B: Uint8Array; Nd: Uint8Array }): PairKeys | null {
  if (i.open.length !== PAIR_OPEN_LEN) throw new Error('PAIR_OPEN must be 82 bytes');
  const nc = fixed('Nc', i.nc, 16);
  const nd = fixed('Nd', i.Nd, 16);
  const z = x25519Shared(fixed('a', i.a, 32), fixed('B', i.B, 32));
  if (!z) return null;
  const t = sha256(LABEL_V3.pair, fixed('mac', i.mac, 6), nc, i.open.slice(2, PAIR_OPEN_LEN), i.B, nd);
  const okm = hkdfSha256(concat(nc, nd), z, t, 64);
  wipe(z);
  const K_pair = okm.slice(0, 32);
  const k_conf = okm.slice(32, 64);
  wipe(okm);
  return { T_pair: t, K_pair, k_conf, proofD: mac16(k_conf, LABEL_V3.dashcam, t), proofP: mac16(k_conf, LABEL_V3.phone, t) };
}

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

/** Seal one VIEW record (1-488 bytes) at `ctr`, direction 3 (the dashcam's side: tests and fakes). */
export function sealView(key: Uint8Array, ctr: number, record: ArrayLike<number>): Uint8Array {
  if (record.length < 1 || record.length > VIEW_RECORD_MAX) throw new Error('a VIEW record is 1-488 bytes');
  return concat(nonceOf(DIR_VIEW, ctr).slice(8, 12), gcmSeal(key, nonceOf(DIR_VIEW, ctr), aadOf(DIR_VIEW), Uint8Array.from(record)));
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
   * Open a VIEW notification (direction 3, the aiming picture's records) under the session's receive
   * key, with a replay window of its own (the dashcam counts VIEW apart from TX).
   */
  openView(wire: ArrayLike<number>): OpenResult;
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
  /** VIEW records' own window (their counter restarts with every key) */
  view: ReplayWindow;
}

const recvKey = (key: ArrayLike<number>): RecvKey => ({ key: Uint8Array.from(key), window: newWindow(), view: newWindow() });

/**
 * The phone's sealer for one session: k_pd out (dir 2), k_dp in (dir 1). `firstCounter` (tests only,
 * as the firmware's debug counter) starts the send counter elsewhere than 0.
 */
export function createSealer(keys: SealerKeys, opts: { firstCounter?: number } = {}): Sealer {
  let send: Uint8Array = Uint8Array.from(keys.send);
  let ctr = opts.firstCounter ?? 0;
  let recv: RecvKey = recvKey(keys.recv);
  /** a staged or committed newer receive key, tried first */
  let newer: RecvKey | null = null;
  let staged: SealerKeys | null = null;
  let committed = false;

  function tryKey(k: RecvKey, wire: ArrayLike<number>, dir: number = DIR_DP): OpenResult | null {
    const o = openRaw(k.key, dir, wire);
    if (!o) return null;
    if (!acceptCounter(dir === DIR_VIEW ? k.view : k.window, o.ctr)) return { ok: false, why: 'replay' };
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
    openView(wire) {
      return (newer ? tryKey(newer, wire, DIR_VIEW) : null) ?? tryKey(recv, wire, DIR_VIEW) ?? { ok: false, why: 'bad' };
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
      newer = recvKey(next.recv);
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

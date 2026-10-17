// A link v3 DashPal played on the fake BLE stack (`../fakeTransport.ts`), for the transport and
// setup unit tests: INFO with this connection's Nc, the AUTH handshakes (one-tap pairing with
// PAIR_OPEN, the provisional phone under a setup hold, sessions with the blinded id over the stored
// phones and the provisional one), sealed TX and RX, COMMAND 3, 4, 5, 7, 8, 9 and 10 (query), and
// switches a test flips to force each verdict. The firmware's own rules are exercised end to end by
// the e2e suites against the real `ble_sim`; this keeps the unit tests fast and deterministic.
import {
  acceptCounter,
  AUTH_MSG,
  AUTH_RECORD,
  AUTH_VERSION,
  blindedId,
  DIR_DP,
  DIR_PD,
  newWindow,
  openRaw,
  PAIR_OPEN_LEN,
  R,
  resultRecord,
  sealRaw,
  sealView,
  sessionKeys,
  type ReplayWindow,
} from '../auth';
import { concat, ctEqual, hkdfSha256, hmacSha256, sha256, utf8, x25519Public, x25519Shared } from '../crypto';
import type { FakeBle, FakeWrite } from '../fakeTransport';
import { AUTH_CHAR, decodeRx, encodeInfo, encodeTx, INFO_CHAR, RX_CHAR, toHex, type RxFrame, type TxFrame } from '../protocol';

export interface FakeDashcamOptions {
  ble: FakeBle;
  /** the peripheral id the phone sees */
  id: string;
  mac: number[];
  phones?: { id: Uint8Array; kPair: Uint8Array }[];
  windowOpen?: boolean;
  protoMax?: number;
  /** deterministic randomness */
  random?: (n: number) => Uint8Array;
}

interface Conn {
  nc: Uint8Array;
  last: number[];
  state: 'none' | 'pair_wait_fin' | 'session_wait' | 'up';
  condemned: boolean;
  pair: { idP: Uint8Array; prev: string | null; kPair: Uint8Array; proofP: Uint8Array } | null;
  pending: { phone: string; kdp: Uint8Array; kpd: Uint8Array; proofP: Uint8Array } | null;
  phone: string | null;
  kdp: Uint8Array | null;
  kpd: Uint8Array | null;
  txCtr: number;
  viewCtr: number;
  rx: ReplayWindow;
}

/** The provisional phone of a setup hold (in RAM only on the board). */
export interface FakeProvisional {
  id: string;
  kPair: Uint8Array;
  /** the proven earlier record it replaces at commit */
  prev: string | null;
}

export interface FakeDashcam {
  readonly phones: Map<string, Uint8Array>;
  readonly received: RxFrame[];
  readonly authWrites: number[][];
  windowOpen: boolean;
  /** another phone holds the setup claim or hold */
  busy: boolean;
  /** the setup hold's provisional phone, while a hold lasts */
  prov: FakeProvisional | null;
  /** the window was opened by Add another phone (COMMAND 3): the aiming stream is not allowed */
  commandWindow: boolean;
  mtu: number;
  protoMax: number;
  /** answer the next AUTH write of this type with this RESULT code (forced verdicts) */
  force: Partial<Record<'pair_open' | 'pair_fin' | 'session_req' | 'session_fin', number>>;
  /** the next COMMAND 8 is answered with this code (R_STORE_FAILED: the hold stays), or commits unanswered (`silent`) */
  commit: number | 'silent' | null;
  /** the next pairing / session answer carries a wrong proof (a device that cannot prove it) */
  badProof: { pair: boolean; session: boolean };
  /** this many AUTH reads answer `pending` before the answer */
  pendingReads: number;
  /** COMMAND 3, 4, 5, 7, 8, 9 and 10 are answered as the firmware does */
  autoAnswer: boolean;
  /** the connection, if any */
  conn(): Conn | null;
  /** the dashcam's TX notification, sealed on the up connection */
  notify(frame: TxFrame | number[]): void;
  /** a VIEW record, sealed in direction 3 on the up connection */
  notifyView(record: number[]): void;
  /** raw bytes on TX (a replay, junk) */
  notifyRaw(bytes: number[]): void;
  /** the last sealed TX wire (to replay it) */
  lastWire(): number[] | null;
  /** INFO as the reader sees it now */
  info(): number[];
  /** the setup hold runs out with its phone connected: SETUP_RESULT(9, R_EXPIRED), then undone */
  expire(): void;
  /** the setup hold is undone without a word (its phone away 60 s, 5 presses) */
  undo(): void;
}

export function createFakeDashcam(o: FakeDashcamOptions): FakeDashcam {
  let seed = 1;
  const random =
    o.random ??
    ((n: number) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        out[i] = (seed >>> 16) & 0xff;
      }
      return out;
    });
  const phones = new Map<string, Uint8Array>();
  for (const p of o.phones ?? []) phones.set(toHex(p.id), p.kPair);
  const mac = Uint8Array.from(o.mac);
  let c: Conn | null = null;
  let last: number[] | null = null;

  /** The hold undone: the provisional phone forgotten, the window open again. */
  function undo(): void {
    self.prov = null;
    self.windowOpen = true;
  }

  const self: FakeDashcam = {
    phones,
    received: [],
    authWrites: [],
    windowOpen: o.windowOpen ?? phones.size === 0,
    busy: false,
    prov: null,
    commandWindow: false,
    mtu: 247,
    protoMax: o.protoMax ?? 3,
    force: {},
    commit: null,
    badProof: { pair: false, session: false },
    pendingReads: 0,
    autoAnswer: true,
    conn: () => c,
    notify(frame) {
      const bytes = Array.isArray(frame) ? frame : encodeTx(frame);
      if (!c || c.state !== 'up' || !c.kdp) return;
      const wire = Array.from(sealRaw(c.kdp, DIR_DP, c.txCtr++, bytes));
      last = wire;
      o.ble.notify(o.id, wire);
    },
    notifyView(record) {
      if (!c || c.state !== 'up' || !c.kdp) return;
      o.ble.notifyView(o.id, Array.from(sealView(c.kdp, c.viewCtr++, record)));
    },
    notifyRaw(bytes) {
      o.ble.notify(o.id, bytes);
    },
    lastWire: () => last,
    info: () =>
      encodeInfo({
        ver: 1,
        protoMin: Math.min(3, self.protoMax),
        protoMax: self.protoMax,
        fwMajor: 3,
        fwMinor: 5,
        mac: o.mac,
        peerBonded: false,
        bondCount: phones.size + (self.prov ? 1 : 0),
        pairingOpen: self.windowOpen || self.prov !== null,
        setupBusy: self.busy,
        nonce: c?.nc ?? new Uint8Array(16),
      }),
    expire() {
      if (!self.prov) return;
      self.notify({ type: 'SETUP_RESULT', op: 9, code: R.EXPIRED, bondCount: phones.size });
      undo();
    },
    undo,
  };

  const result = (code: number): number[] => Array.from(resultRecord(code));
  const mac16 = (k: Uint8Array, ...parts: ArrayLike<number>[]) => hmacSha256(k, ...parts).slice(0, 16);

  function pairOpen(conn: Conn, b: Uint8Array): number[] {
    if (self.force.pair_open !== undefined) {
      const code = self.force.pair_open;
      delete self.force.pair_open;
      return result(code);
    }
    if (self.mtu < 43) return result(R.MTU);
    if (conn.condemned) return result(R.NOT_NOW);
    if (!self.windowOpen && conn.state !== 'pair_wait_fin') return result(R.NOT_NOW);
    if (self.busy || self.prov) return result(R.BUSY);
    const idP = b.slice(2, 10);
    if (idP.every((x) => x === 0) || phones.has(toHex(idP))) return result(R.ID_IN_USE);
    const nc = conn.nc;
    conn.nc = random(16);
    const prevId = b.slice(10, 18);
    const prevProof = b.slice(18, 34);
    const prevKey = phones.get(toHex(prevId));
    const prevOk = !prevId.every((x) => x === 0) && prevKey !== undefined && ctEqual(mac16(prevKey, utf8('DPv3 replace'), mac, nc, idP), prevProof);
    const A = b.slice(34, 66);
    const priv = random(32);
    const B = x25519Public(priv);
    const nd = random(16);
    const z = x25519Shared(priv, A);
    if (!z) {
      conn.condemned = true;
      return result(R.BAD_KEY);
    }
    const t = sha256(utf8('DPv3 pair'), mac, nc, b.slice(2, PAIR_OPEN_LEN), B, nd);
    const okm = hkdfSha256(concat(nc, nd), z, t, 64);
    const kConf = okm.slice(32, 64);
    let proofD = mac16(kConf, utf8('DPv3 dashcam'), t);
    if (self.badProof.pair) {
      self.badProof.pair = false;
      proofD = Uint8Array.from(proofD, (x, i) => (i === 0 ? x ^ 1 : x));
    }
    conn.pair = { idP, prev: prevOk ? toHex(prevId) : null, kPair: okm.slice(0, 32), proofP: mac16(kConf, utf8('DPv3 phone'), t) };
    conn.state = 'pair_wait_fin';
    return [AUTH_RECORD.PAIR_RESP, AUTH_VERSION, ...B, ...nd, ...proofD];
  }

  function pairFin(conn: Conn, b: Uint8Array): number[] {
    if (self.force.pair_fin !== undefined) {
      const code = self.force.pair_fin;
      delete self.force.pair_fin;
      conn.pair = null;
      conn.state = 'none';
      return result(code);
    }
    if (conn.state !== 'pair_wait_fin' || !conn.pair || conn.condemned) return result(R.NOT_NOW);
    if (!ctEqual(conn.pair.proofP, b.slice(2, 18))) {
      conn.condemned = true;
      return result(R.WRONG_PROOF);
    }
    // Held provisionally under the setup hold: nothing is stored yet.
    self.prov = { id: toHex(conn.pair.idP), kPair: conn.pair.kPair, prev: conn.pair.prev };
    conn.pair = null;
    conn.state = 'none';
    return result(R.OK);
  }

  function sessionReq(conn: Conn, b: Uint8Array): number[] {
    if (self.force.session_req !== undefined) {
      const code = self.force.session_req;
      delete self.force.session_req;
      return result(code);
    }
    if (self.mtu < 43) return result(R.MTU);
    if (conn.condemned || conn.state === 'pair_wait_fin') return result(R.NOT_NOW);
    const bid = b.slice(2, 10);
    const np = b.slice(10, 26);
    const records: [string, Uint8Array][] = [...phones.entries()];
    if (self.prov) records.push([self.prov.id, self.prov.kPair]);
    const match = records.find(([, k]) => ctEqual(blindedId(k, mac, conn.nc), bid));
    if (!match) return result(R.UNKNOWN_PHONE);
    const nd = random(16);
    const keys = sessionKeys(match[1], mac, Uint8Array.from(match[0].match(/../g)!.map((h) => parseInt(h, 16))), np, nd);
    let proofD = keys.proofD;
    if (self.badProof.session) {
      self.badProof.session = false;
      proofD = Uint8Array.from(proofD, (x, i) => (i === 0 ? x ^ 1 : x));
    }
    conn.pending = { phone: match[0], kdp: keys.k_dp, kpd: keys.k_pd, proofP: keys.proofP };
    if (conn.state !== 'up') conn.state = 'session_wait';
    return [AUTH_RECORD.SESSION_RESP, AUTH_VERSION, ...nd, ...proofD];
  }

  function sessionFin(conn: Conn, b: Uint8Array): number[] {
    if (self.force.session_fin !== undefined) {
      const code = self.force.session_fin;
      delete self.force.session_fin;
      conn.pending = null;
      return result(code);
    }
    if (!conn.pending || conn.condemned) return result(R.NOT_NOW);
    if (!ctEqual(conn.pending.proofP, b.slice(2, 18))) {
      conn.pending = null;
      if (conn.state !== 'up') conn.condemned = true;
      return result(R.WRONG_PROOF);
    }
    conn.phone = conn.pending.phone;
    conn.kdp = conn.pending.kdp;
    conn.kpd = conn.pending.kpd;
    conn.txCtr = 0;
    conn.viewCtr = 0;
    conn.rx = newWindow();
    conn.pending = null;
    conn.state = 'up';
    return result(R.OK);
  }

  function onAuth(conn: Conn, bytes: number[]): void {
    const b = Uint8Array.from(bytes);
    self.authWrites.push([...bytes]);
    const lens: Record<number, number> = { [AUTH_MSG.PAIR_OPEN]: PAIR_OPEN_LEN, [AUTH_MSG.PAIR_FIN]: 18, [AUTH_MSG.SESSION_REQ]: 26, [AUTH_MSG.SESSION_FIN]: 18 };
    if (b.length < 2 || b[1] !== AUTH_VERSION || lens[b[0]!] !== b.length) throw { message: 'Write failed, status=128' };
    switch (b[0]) {
      case AUTH_MSG.PAIR_OPEN:
        conn.last = pairOpen(conn, b);
        break;
      case AUTH_MSG.PAIR_FIN:
        conn.last = pairFin(conn, b);
        break;
      case AUTH_MSG.SESSION_REQ:
        conn.last = sessionReq(conn, b);
        break;
      default:
        conn.last = sessionFin(conn, b);
        break;
    }
  }

  /** The provisional phone stored (a proven earlier record removed first, then the oldest at 4). */
  function store(p: FakeProvisional): void {
    if (p.prev) phones.delete(p.prev);
    if (phones.size >= 4) phones.delete([...phones.keys()][0]!);
    phones.set(p.id, p.kPair);
    self.prov = null;
    self.windowOpen = false;
    self.commandWindow = false;
  }

  /** COMMAND 8: the hold's connection commits; a committed phone whose answer was lost gets R_OK again. */
  function commit(conn: Conn): void {
    const p = self.prov;
    if (!p || conn.phone !== p.id) {
      const code = conn.phone !== null && phones.has(conn.phone) ? R.OK : R.NOT_NOW;
      self.notify({ type: 'SETUP_RESULT', op: 8, code, bondCount: phones.size });
      return;
    }
    const forced = self.commit;
    self.commit = null;
    if (forced === 'silent') {
      store(p);
      return;
    }
    if (forced !== null && forced !== R.OK) {
      self.notify({ type: 'SETUP_RESULT', op: 8, code: forced, bondCount: phones.size });
      return;
    }
    store(p);
    self.notify({ type: 'SETUP_RESULT', op: 8, code: R.OK, bondCount: phones.size });
  }

  function onRx(conn: Conn, wire: number[]): void {
    if (conn.state !== 'up' || !conn.kpd) return;
    const opened = openRaw(conn.kpd, DIR_PD, wire);
    if (!opened || !acceptCounter(conn.rx, opened.ctr)) return;
    const d = decodeRx(Array.from(opened.frame));
    if (!d.ok) return;
    self.received.push(d.frame);
    if (!self.autoAnswer || d.frame.type !== 'COMMAND') return;
    const holds = self.prov !== null && conn.phone === self.prov.id;
    switch (d.frame.op) {
      case 7:
        self.notify({ type: 'HELLO', bootId: 0x2a, nextSeq: 0, oldestSeq: 0, uptimeMs: 1000 });
        self.notify({ type: 'STATUS', uptimeMs: 1000, state: 3, flags: 0, fpsX10: 150, tempC: 40, bondCount: phones.size });
        break;
      case 5:
        self.notify({ type: 'PAIRED', bondCount: phones.size + (self.prov ? 1 : 0) });
        break;
      case 3:
        if (holds) break;
        self.prov = null;
        self.windowOpen = true;
        self.commandWindow = true;
        break;
      case 4:
        if (holds) {
          self.notify({ type: 'SETUP_RESULT', op: 9, code: R.OK, bondCount: phones.size });
          undo();
        } else if (conn.phone) {
          phones.delete(conn.phone);
        }
        break;
      case 8:
        commit(conn);
        break;
      case 9:
        if (holds) {
          self.notify({ type: 'SETUP_RESULT', op: 9, code: R.OK, bondCount: phones.size });
          undo();
        } else {
          self.notify({ type: 'SETUP_RESULT', op: 9, code: R.NOT_NOW, bondCount: phones.size });
        }
        break;
      case 10:
        if (d.frame.arg === 2) self.notify({ type: 'VIEW_STATE', on: holds && !self.commandWindow ? 1 : 0, reason: !holds ? 9 : self.commandWindow ? 1 : 0, leftS: 600 });
        break;
      default:
        break;
    }
  }

  const prevConnect = o.ble.onConnect;
  o.ble.onConnect = (id) => {
    prevConnect?.(id);
    if (id !== o.id) return;
    c = { nc: random(16), last: [0], state: 'none', condemned: false, pair: null, pending: null, phone: null, kdp: null, kpd: null, txCtr: 0, viewCtr: 0, rx: newWindow() };
  };
  const prevDisconnect = o.ble.onDisconnect;
  o.ble.onDisconnect = (id) => {
    prevDisconnect?.(id);
    if (id === o.id) c = null;
  };
  const prevRead = o.ble.onRead;
  o.ble.onRead = (id, characteristic) => {
    if (id !== o.id) return prevRead?.(id, characteristic);
    if (characteristic === INFO_CHAR) return self.info();
    if (characteristic === AUTH_CHAR) {
      if (!c) throw { message: 'Device is not connected' };
      if (self.pendingReads > 0) {
        self.pendingReads -= 1;
        return [0];
      }
      return c.last;
    }
    return prevRead?.(id, characteristic);
  };
  const prevWrite = o.ble.onWrite;
  o.ble.onWrite = (w: FakeWrite) => {
    if (w.id !== o.id) return prevWrite?.(w);
    if (!c) throw { message: 'Device is not connected' };
    if (w.characteristic === AUTH_CHAR) onAuth(c, w.bytes);
    else if (w.characteristic === RX_CHAR) onRx(c, w.bytes);
    return undefined;
  };
  o.ble.addPeripheral({ id: o.id, name: `DashPal-${toHex(o.mac.slice(4)).toUpperCase()}`, rssi: -50 });
  return self;
}

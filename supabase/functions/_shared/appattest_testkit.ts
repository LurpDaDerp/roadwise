// Tests only: a stand-in for Apple's side of App Attest, built with WebCrypto at test time. A fake
// "Apple App Attestation Root CA" (P-384) signs an intermediate CA (P-384), which signs a credential
// certificate (P-256) carrying the nonce extension, exactly in the shape `verifyAttestation` reads;
// the credential key then signs assertions as the phone's Secure Enclave would. Every field can be
// bent to test one refusal at a time. The verifiers are handed this root through `root`.
import { appIdHash, concat, fromHex, sha256, sha256Text, toBase64 } from './appattest.ts';

const te = new TextEncoder();

// --- DER ---------------------------------------------------------------------

function tlv(tag: number, ...content: Uint8Array[]): Uint8Array {
  const body = concat(...content);
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return concat(new Uint8Array([tag, ...len]), body);
}
const seq = (...c: Uint8Array[]) => tlv(0x30, ...c);
const oid = (hex: string) => tlv(0x06, fromHex(hex)!);
const octets = (b: Uint8Array) => tlv(0x04, b);
const bits = (b: Uint8Array) => tlv(0x03, new Uint8Array([0]), b);
const bool = (v: boolean) => tlv(0x01, new Uint8Array([v ? 0xff : 0]));
const explicit = (n: number, ...c: Uint8Array[]) => tlv(0xa0 + n, ...c);

function integer(b: Uint8Array): Uint8Array {
  let v = b;
  while (v.length > 1 && v[0] === 0 && v[1] < 0x80) v = v.subarray(1);
  if (v[0] >= 0x80) v = concat(new Uint8Array([0]), v);
  return tlv(0x02, v);
}

function utcTime(ms: number): Uint8Array {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, te.encode(s));
}

const commonName = (cn: string) => seq(tlv(0x31, seq(oid('550403'), tlv(0x0c, te.encode(cn)))));

/** WebCrypto's r || s as a DER ECDSA signature. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  return seq(integer(raw.subarray(0, half)), integer(raw.subarray(half)));
}

const OID = {
  ecdsaSha256: '2a8648ce3d040302',
  ecdsaSha384: '2a8648ce3d040303',
  basicConstraints: '551d13',
  appleNonce: '2a864886f763640802',
};

// --- keys and certificates ------------------------------------------------------

export type Curve = 'P-256' | 'P-384';

export const ecKeys = (curve: Curve): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;

/** The uncompressed EC point of a public key. */
export const pointOf = async (key: CryptoKey): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.exportKey('raw', key));

export interface CertSpec {
  subject: string;
  issuer: string;
  /** The certified key. */
  publicKey: CryptoKey;
  /** The issuer's private key and curve. */
  signer: CryptoKey;
  signerCurve: Curve;
  /** basicConstraints CA flag; left out entirely when undefined. */
  ca?: boolean;
  notBefore: number;
  notAfter: number;
  /** More extensions (DER Extension sequences). */
  extensions?: Uint8Array[];
}

let serial = 1;

export async function makeCert(spec: CertSpec): Promise<Uint8Array> {
  const alg = seq(oid(spec.signerCurve === 'P-384' ? OID.ecdsaSha384 : OID.ecdsaSha256));
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', spec.publicKey));
  const exts = [
    ...(spec.ca === undefined ? [] : [seq(oid(OID.basicConstraints), bool(true), octets(seq(...(spec.ca ? [bool(true)] : []))))]),
    ...(spec.extensions ?? []),
  ];
  const tbs = seq(
    explicit(0, integer(new Uint8Array([2]))),
    integer(new Uint8Array([0, serial++])),
    alg,
    commonName(spec.issuer),
    seq(utcTime(spec.notBefore), utcTime(spec.notAfter)),
    commonName(spec.subject),
    spki,
    ...(exts.length ? [explicit(3, seq(...exts))] : [])
  );
  const hash = spec.signerCurve === 'P-384' ? 'SHA-384' : 'SHA-256';
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash }, spec.signer, concat(tbs)));
  return seq(tbs, alg, bits(rawToDer(raw)));
}

const YEAR = 365 * 86_400_000;

export interface FakeApple {
  root: Uint8Array;
  intermediate: Uint8Array;
  intermediateKey: CryptoKeyPair;
}

/** A fake Apple root and intermediate, valid from a year before `now` to ten years after. */
export async function fakeApple(now: number, opts: { intermediateCa?: boolean } = {}): Promise<FakeApple> {
  const rootKey = await ecKeys('P-384');
  const intermediateKey = await ecKeys('P-384');
  const window = { notBefore: now - YEAR, notAfter: now + 10 * YEAR };
  const root = await makeCert({ subject: 'Fake App Attestation Root CA', issuer: 'Fake App Attestation Root CA', publicKey: rootKey.publicKey, signer: rootKey.privateKey, signerCurve: 'P-384', ca: true, ...window });
  const intermediate = await makeCert({
    subject: 'Fake App Attestation CA 1',
    issuer: 'Fake App Attestation Root CA',
    publicKey: intermediateKey.publicKey,
    signer: rootKey.privateKey,
    signerCurve: 'P-384',
    ca: opts.intermediateCa ?? true,
    ...window,
  });
  return { root, intermediate, intermediateKey };
}

// --- CBOR ---------------------------------------------------------------------

type CborIn = number | string | Uint8Array | CborIn[] | Map<string | number, CborIn>;

function head(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 0x100) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 0x10000) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
  return new Uint8Array([(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

export function encodeCbor(v: CborIn): Uint8Array {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const b = te.encode(v);
    return concat(head(3, b.length), b);
  }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  if (Array.isArray(v)) return concat(head(4, v.length), ...v.map(encodeCbor));
  return concat(head(5, v.size), ...[...v].flatMap(([k, x]) => [encodeCbor(k), encodeCbor(x)]));
}

const cborMap = (o: Record<string, CborIn>): Map<string, CborIn> => new Map(Object.entries(o));

// --- attestation and assertion ----------------------------------------------------

const AAGUID_PRODUCTION = te.encode('appattest\0\0\0\0\0\0\0');
const AAGUID_DEVELOPMENT = te.encode('appattestdevelop');

export interface AttestationSpec {
  apple: FakeApple;
  teamId: string;
  bundleId?: string;
  /** The challenge string the phone was handed. */
  challenge: string;
  now: number;
  environment?: 'production' | 'development';
  counter?: number;
  /** A credential id other than the key id. */
  credentialId?: Uint8Array;
  /** A nonce other than the right one. */
  nonce?: Uint8Array;
  fmt?: string;
  /** Leave the intermediate out of x5c. */
  leafOnly?: boolean;
}

export interface MadeAttestation {
  keyId: string;
  attestation: string;
  key: CryptoKeyPair;
  point: Uint8Array;
}

export async function makeAttestation(spec: AttestationSpec): Promise<MadeAttestation> {
  const key = await ecKeys('P-256');
  const point = await pointOf(key.publicKey);
  const keyIdBytes = await sha256(point);
  const rpIdHash = await appIdHash(spec.teamId, spec.bundleId);
  const credentialId = spec.credentialId ?? keyIdBytes;
  const cose = encodeCbor(new Map<number, CborIn>([[1, 2], [3, -7], [-1, 1], [-2, point.subarray(1, 33)], [-3, point.subarray(33)]]));
  const counter = spec.counter ?? 0;
  const authData = concat(
    rpIdHash,
    new Uint8Array([0x40, (counter >>> 24) & 0xff, (counter >> 16) & 0xff, (counter >> 8) & 0xff, counter & 0xff]),
    spec.environment === 'development' ? AAGUID_DEVELOPMENT : AAGUID_PRODUCTION,
    new Uint8Array([credentialId.length >> 8, credentialId.length & 0xff]),
    credentialId,
    cose
  );
  const nonce = spec.nonce ?? (await sha256(authData, await sha256Text(spec.challenge)));
  const nonceExt = seq(oid(OID.appleNonce), octets(seq(explicit(1, octets(nonce)))));
  const leaf = await makeCert({
    subject: 'credential',
    issuer: 'Fake App Attestation CA 1',
    publicKey: key.publicKey,
    signer: spec.apple.intermediateKey.privateKey,
    signerCurve: 'P-384',
    notBefore: spec.now - 86_400_000,
    notAfter: spec.now + 3 * 86_400_000,
    extensions: [nonceExt],
  });
  const x5c = spec.leafOnly ? [leaf] : [leaf, spec.apple.intermediate];
  const obj = cborMap({ fmt: spec.fmt ?? 'apple-appattest', attStmt: cborMap({ x5c, receipt: new Uint8Array([1, 2, 3]) }), authData });
  return { keyId: toBase64(keyIdBytes), attestation: toBase64(encodeCbor(obj)), key, point };
}

/** The phone's assertion over `body` (as `generateAssertionAsync(keyId, body)` makes it). */
export async function makeAssertion(spec: { key: CryptoKeyPair; teamId: string; bundleId?: string; counter: number; body: Uint8Array | string }): Promise<string> {
  const rpIdHash = await appIdHash(spec.teamId, spec.bundleId);
  const c = spec.counter;
  const authenticatorData = concat(rpIdHash, new Uint8Array([0x00, (c >>> 24) & 0xff, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]));
  const body = typeof spec.body === 'string' ? te.encode(spec.body) : spec.body;
  const nonce = await sha256(authenticatorData, await sha256(body));
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, spec.key.privateKey, concat(nonce)));
  return toBase64(encodeCbor(cborMap({ signature: rawToDer(raw), authenticatorData })));
}

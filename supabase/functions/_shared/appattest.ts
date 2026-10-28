// App Attest (iPhone): the server half of Apple's DeviceCheck App Attest.
//
// The phone makes a key in its Secure Enclave and asks Apple to attest it: Apple answers with an
// attestation object, a certificate for the key that chains to the Apple App Attestation Root CA
// and carries a nonce binding it to this app (team and bundle id) and to a one-time challenge of
// ours. `verifyAttestation` checks all of that (Apple's "Validating apps that connect to your
// server", steps 1 to 9) and hands back the key to store. After that, each upload carries an
// assertion: the key's signature over SHA256(authenticatorData || SHA256(the exact request body)),
// with a counter that only goes up. `verifyAssertion` checks the signature, the app and the counter.
//
// Self-contained on purpose: a small CBOR reader and a small DER reader, and WebCrypto for every
// signature (ECDSA P-256 and P-384). Nothing here touches the database, the network or the clock:
// the trust anchor and the time come in as arguments, so the tests can sign their own chain.
//
// Every failure is a short reason code for the log, never the bytes it was about.

const te = new TextEncoder();

/**
 * Apple App Attestation Root CA (https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem),
 * P-384, valid 2020-03-18 to 2045-03-15. SHA-256 fingerprint
 * 1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32.
 */
export const APPLE_APP_ATTESTATION_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

/** The app's bundle id (app.config.ts `ios.bundleIdentifier`). */
export const BUNDLE_ID = 'com.lurp.safedrive';

export type AttestEnvironment = 'production' | 'development';

/** The authenticator data's aaguid: "appattest" and seven zero bytes in production, "appattestdevelop" in the sandbox. */
const AAGUID: Readonly<Record<AttestEnvironment, string>> = {
  production: 'appattest\0\0\0\0\0\0\0',
  development: 'appattestdevelop',
};

/** Largest attestation object read (Apple's are about 5 KB: two certificates and a receipt). */
export const MAX_ATTESTATION_BYTES = 16_384;
/** Largest assertion read (Apple's are about 150 bytes). */
export const MAX_ASSERTION_BYTES = 1024;
/** A key id is the SHA-256 of the key: 32 bytes, 44 base64 characters. */
export const KEY_ID_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

// ---------------------------------------------------------------------------
// bytes
// ---------------------------------------------------------------------------

/** The parts in one new buffer (also how a view becomes a plain ArrayBuffer-backed copy for WebCrypto). */
export const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...parts)));
}

/** SHA-256 of the UTF-8 bytes of `text`. */
export const sha256Text = (text: string): Promise<Uint8Array> => sha256(te.encode(text));

/** The authenticator data's rpIdHash for this app: SHA256("<team id>.<bundle id>"). */
export const appIdHash = (teamId: string, bundleId: string = BUNDLE_ID): Promise<Uint8Array> => sha256Text(`${teamId}.${bundleId}`);

export const toHex = (b: Uint8Array): string => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');

export function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Standard base64 (padded, as Foundation writes it) to bytes, or null when it is not that or is longer than `maxBytes`. */
export function fromBase64(s: string, maxBytes: number): Uint8Array | null {
  if (s.length === 0 || s.length > Math.ceil(maxBytes / 3) * 4 || !BASE64.test(s)) return null;
  const bin = atob(s);
  if (bin.length > maxBytes) return null;
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const toBase64 = (b: Uint8Array): string => btoa(Array.from(b, (v) => String.fromCharCode(v)).join(''));

const PEM_BODY = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/;

/** A PEM certificate's DER bytes. */
export function pemToDer(pem: string): Uint8Array {
  const m = PEM_BODY.exec(pem);
  const der = m ? fromBase64(m[1].replace(/\s+/g, ''), 65_536) : null;
  if (!der) throw new Error('not a PEM certificate');
  return der;
}

// ---------------------------------------------------------------------------
// CBOR (RFC 8949): the definite-length subset Apple writes, nothing else
// ---------------------------------------------------------------------------

export type Cbor = number | string | boolean | null | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

class Malformed extends Error {}

const MAX_CBOR_DEPTH = 8;
const MAX_CBOR_ITEMS = 64;

/** Decodes one CBOR item that fills `bytes` exactly; throws `Malformed` otherwise. */
export function decodeCbor(bytes: Uint8Array): Cbor {
  let at = 0;
  const need = (n: number): void => {
    if (n < 0 || at + n > bytes.length) throw new Malformed('cbor: short');
  };
  const arg = (info: number): number => {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (size === 0) throw new Malformed('cbor: unsupported length');
    need(size);
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + bytes[at + i];
    at += size;
    if (!Number.isSafeInteger(v)) throw new Malformed('cbor: integer too large');
    return v;
  };
  const item = (depth: number): Cbor => {
    if (depth > MAX_CBOR_DEPTH) throw new Malformed('cbor: too deep');
    need(1);
    const head = bytes[at++];
    const major = head >> 5;
    const info = head & 31;
    switch (major) {
      case 0:
        return arg(info);
      case 1:
        return -1 - arg(info);
      case 2: {
        const n = arg(info);
        need(n);
        const out = bytes.slice(at, at + n);
        at += n;
        return out;
      }
      case 3: {
        const n = arg(info);
        need(n);
        const out = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(at, at + n));
        at += n;
        return out;
      }
      case 4: {
        const n = arg(info);
        if (n > MAX_CBOR_ITEMS) throw new Malformed('cbor: array too long');
        const out: Cbor[] = [];
        for (let i = 0; i < n; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const n = arg(info);
        if (n > MAX_CBOR_ITEMS) throw new Malformed('cbor: map too long');
        const out = new Map<Cbor, Cbor>();
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          if (typeof k !== 'string' && typeof k !== 'number') throw new Malformed('cbor: map key');
          if (out.has(k)) throw new Malformed('cbor: duplicate key');
          out.set(k, item(depth + 1));
        }
        return out;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Malformed('cbor: unsupported simple value');
      default:
        // tags (6) are never in what Apple sends
        throw new Malformed('cbor: unsupported type');
    }
  };
  const out = item(0);
  if (at !== bytes.length) throw new Malformed('cbor: trailing bytes');
  return out;
}

const field = (m: Cbor, key: string): Cbor | undefined => (m instanceof Map ? m.get(key) : undefined);

// ---------------------------------------------------------------------------
// DER (X.690): the tag-length-value reader the certificates need
// ---------------------------------------------------------------------------

interface Tlv {
  tag: number;
  /** The whole element: tag, length and content. */
  raw: Uint8Array;
  /** The content octets. */
  value: Uint8Array;
}

/** One element at `at` (low tag numbers only, definite lengths of up to 4 bytes). */
function readTlv(buf: Uint8Array, at: number): Tlv {
  if (at + 2 > buf.length) throw new Malformed('der: short');
  const tag = buf[at];
  if ((tag & 0x1f) === 0x1f) throw new Malformed('der: high tag number');
  let len = buf[at + 1];
  let head = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || at + 2 + n > buf.length) throw new Malformed('der: length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i];
    head += n;
  }
  if (at + head + len > buf.length) throw new Malformed('der: overrun');
  return { tag, raw: buf.subarray(at, at + head + len), value: buf.subarray(at + head, at + head + len) };
}

/** The element that fills `buf` exactly, with the expected tag. */
function readOne(buf: Uint8Array, tag: number): Tlv {
  const t = readTlv(buf, 0);
  if (t.tag !== tag || t.raw.length !== buf.length) throw new Malformed('der: unexpected element');
  return t;
}

/** The elements inside a constructed element. */
function childrenOf(t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let at = 0;
  while (at < t.value.length) {
    const c = readTlv(t.value, at);
    out.push(c);
    at += c.raw.length;
  }
  return out;
}

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OCTET_STRING = 0x04;
const OID = 0x06;
const BOOLEAN = 0x01;
const UTC_TIME = 0x17;
const GENERALIZED_TIME = 0x18;

/** Object identifiers, as their DER content in hex. */
const OIDS = {
  ecPublicKey: '2a8648ce3d0201', // 1.2.840.10045.2.1
  p256: '2a8648ce3d030107', // 1.2.840.10045.3.1.7
  p384: '2b81040022', // 1.3.132.0.34
  ecdsaSha256: '2a8648ce3d040302', // 1.2.840.10045.4.3.2
  ecdsaSha384: '2a8648ce3d040303', // 1.2.840.10045.4.3.3
  basicConstraints: '551d13', // 2.5.29.19
  appleNonce: '2a864886f763640802', // 1.2.840.113635.100.8.2
} as const;

type Curve = 'P-256' | 'P-384';
const CURVE_BYTES: Readonly<Record<Curve, number>> = { 'P-256': 32, 'P-384': 48 };

interface Certificate {
  tbs: Uint8Array;
  signatureHash: 'SHA-256' | 'SHA-384';
  signature: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  /** The SubjectPublicKeyInfo, as WebCrypto imports it. */
  spki: Uint8Array;
  curve: Curve;
  /** The uncompressed EC point (0x04 || X || Y). */
  point: Uint8Array;
  ca: boolean;
  /** Extension values (the OCTET STRING content) by OID hex. */
  extensions: Map<string, Uint8Array>;
}

const twoDigits = (s: string, i: number): number => Number(s.slice(i, i + 2));

/** UTCTime (YYMMDDHHMMSSZ, 1950 to 2049) or GeneralizedTime (YYYYMMDDHHMMSSZ), as epoch ms. */
function readTime(t: Tlv): number {
  const s = new TextDecoder().decode(t.value);
  let year: number;
  let rest: string;
  if (t.tag === UTC_TIME && /^\d{12}Z$/.test(s)) {
    const yy = twoDigits(s, 0);
    year = yy < 50 ? 2000 + yy : 1900 + yy;
    rest = s.slice(2);
  } else if (t.tag === GENERALIZED_TIME && /^\d{14}Z$/.test(s)) {
    year = Number(s.slice(0, 4));
    rest = s.slice(4);
  } else {
    throw new Malformed('der: time');
  }
  return Date.UTC(year, twoDigits(rest, 0) - 1, twoDigits(rest, 2), twoDigits(rest, 4), twoDigits(rest, 6), twoDigits(rest, 8));
}

/** The content of a BIT STRING with no unused bits. */
function bitString(t: Tlv): Uint8Array {
  if (t.tag !== BIT_STRING || t.value.length < 1 || t.value[0] !== 0) throw new Malformed('der: bit string');
  return t.value.subarray(1);
}

function parseCertificate(der: Uint8Array): Certificate {
  const [tbsT, algT, sigT, ...more] = childrenOf(readOne(der, SEQUENCE));
  if (!tbsT || !algT || !sigT || more.length > 0 || tbsT.tag !== SEQUENCE || algT.tag !== SEQUENCE) throw new Malformed('cert: shape');
  const algOid = childrenOf(algT)[0];
  if (!algOid || algOid.tag !== OID) throw new Malformed('cert: algorithm');
  const alg = toHex(algOid.value);
  const signatureHash = alg === OIDS.ecdsaSha256 ? 'SHA-256' : alg === OIDS.ecdsaSha384 ? 'SHA-384' : null;
  if (!signatureHash) throw new Malformed('cert: signature algorithm');

  const tbs = childrenOf(tbsT);
  let i = 0;
  if (tbs[i]?.tag === 0xa0) i++; // [0] version
  if (tbs[i]?.tag !== INTEGER) throw new Malformed('cert: serial');
  i++;
  const innerAlg = tbs[i++];
  if (innerAlg?.tag !== SEQUENCE || !equalBytes(innerAlg.raw, algT.raw)) throw new Malformed('cert: inner algorithm');
  const issuer = tbs[i++];
  const validity = tbs[i++];
  const subject = tbs[i++];
  const spkiT = tbs[i++];
  if (issuer?.tag !== SEQUENCE || validity?.tag !== SEQUENCE || subject?.tag !== SEQUENCE || spkiT?.tag !== SEQUENCE) throw new Malformed('cert: tbs');
  const [nb, na] = childrenOf(validity);
  if (!nb || !na) throw new Malformed('cert: validity');

  const [keyAlgT, keyBits] = childrenOf(spkiT);
  const [keyOid, curveOid] = keyAlgT?.tag === SEQUENCE ? childrenOf(keyAlgT) : [];
  if (keyOid?.tag !== OID || toHex(keyOid.value) !== OIDS.ecPublicKey || curveOid?.tag !== OID || !keyBits) throw new Malformed('cert: key');
  const curveHex = toHex(curveOid.value);
  const curve: Curve | null = curveHex === OIDS.p256 ? 'P-256' : curveHex === OIDS.p384 ? 'P-384' : null;
  if (!curve) throw new Malformed('cert: curve');
  const point = bitString(keyBits);
  if (point.length !== 1 + 2 * CURVE_BYTES[curve] || point[0] !== 0x04) throw new Malformed('cert: point');

  const extensions = new Map<string, Uint8Array>();
  let ca = false;
  for (; i < tbs.length; i++) {
    if (tbs[i].tag !== 0xa3) continue; // [1] and [2] unique ids are skipped
    const list = childrenOf(tbs[i])[0];
    if (list?.tag !== SEQUENCE) throw new Malformed('cert: extensions');
    for (const ext of childrenOf(list)) {
      const parts = childrenOf(ext);
      const id = parts[0];
      const value = parts[parts.length - 1];
      if (id?.tag !== OID || value?.tag !== OCTET_STRING || parts.length > 3 || (parts.length === 3 && parts[1].tag !== BOOLEAN)) {
        throw new Malformed('cert: extension');
      }
      const key = toHex(id.value);
      if (extensions.has(key)) throw new Malformed('cert: duplicate extension');
      extensions.set(key, value.value);
    }
  }
  const bc = extensions.get(OIDS.basicConstraints);
  if (bc) {
    const flag = childrenOf(readOne(bc, SEQUENCE))[0];
    ca = flag?.tag === BOOLEAN && flag.value.length === 1 && flag.value[0] !== 0;
  }

  return {
    tbs: tbsT.raw,
    signatureHash,
    signature: bitString(sigT),
    issuer: issuer.raw,
    subject: subject.raw,
    notBefore: readTime(nb),
    notAfter: readTime(na),
    spki: spkiT.raw,
    curve,
    point,
    ca,
    extensions,
  };
}

/** A DER ECDSA signature (SEQUENCE of r and s) as WebCrypto's r || s, each `size` bytes. */
export function derSignatureToRaw(der: Uint8Array, size: number): Uint8Array {
  const parts = childrenOf(readOne(der, SEQUENCE));
  if (parts.length !== 2 || parts.some((p) => p.tag !== INTEGER)) throw new Malformed('der: ecdsa signature');
  const out = new Uint8Array(size * 2);
  parts.forEach((p, k) => {
    let v = p.value;
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Malformed('der: ecdsa integer');
    out.set(v, k * size + size - v.length);
  });
  return out;
}

async function verifyEcdsa(key: CryptoKey, curve: Curve, hash: 'SHA-256' | 'SHA-384', derSignature: Uint8Array, data: Uint8Array): Promise<boolean> {
  let raw: Uint8Array;
  try {
    raw = derSignatureToRaw(derSignature, CURVE_BYTES[curve]);
  } catch {
    return false;
  }
  return await crypto.subtle.verify({ name: 'ECDSA', hash }, key, concat(raw), concat(data));
}

/** Whether `child` was signed by `issuer` (names chained, the issuer a CA). */
async function signedBy(child: Certificate, issuer: Certificate): Promise<boolean> {
  if (!issuer.ca || !equalBytes(child.issuer, issuer.subject)) return false;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('spki', concat(issuer.spki), { name: 'ECDSA', namedCurve: issuer.curve }, false, ['verify']);
  } catch {
    return false;
  }
  return verifyEcdsa(key, issuer.curve, child.signatureHash, child.signature, child.tbs);
}

// ---------------------------------------------------------------------------
// authenticator data
// ---------------------------------------------------------------------------

interface AuthData {
  rpIdHash: Uint8Array;
  counter: number;
  /** Present in an attestation's (the attested credential data). */
  aaguid: Uint8Array | null;
  credentialId: Uint8Array | null;
}

function parseAuthData(b: Uint8Array, attested: boolean): AuthData {
  if (b.length < 37) throw new Malformed('authData: short');
  const counter = ((b[33] << 24) >>> 0) + (b[34] << 16) + (b[35] << 8) + b[36];
  if (!attested) return { rpIdHash: b.subarray(0, 32), counter, aaguid: null, credentialId: null };
  if (b.length < 55) throw new Malformed('authData: no credential');
  const idLen = (b[53] << 8) + b[54];
  if (55 + idLen > b.length) throw new Malformed('authData: credential id');
  return { rpIdHash: b.subarray(0, 32), counter, aaguid: b.subarray(37, 53), credentialId: b.subarray(55, 55 + idLen) };
}

// ---------------------------------------------------------------------------
// attestation
// ---------------------------------------------------------------------------

export interface AttestationInput {
  /** The key id the phone names (base64 of its 32 bytes). */
  keyId: string;
  /** The attestation object (base64). */
  attestation: string;
  /** SHA256 of our challenge, as the phone hashed it (`attestKeyAsync` hashes the challenge's UTF-8). */
  clientDataHash: Uint8Array;
}

export interface VerifyConfig {
  /** `appIdHash(teamId)`. */
  rpIdHash: Uint8Array;
  /** Accept the sandbox (`appattestdevelop`) as well as production. */
  allowDevelopment: boolean;
  /** Epoch ms the certificates must be valid at. */
  now: number;
  /** The trust anchor's DER: Apple's root unless a test brings its own. */
  root?: Uint8Array;
}

export type AttestationFailure =
  | 'malformed'
  | 'format'
  | 'chain'
  | 'expired'
  | 'nonce'
  | 'key_id'
  | 'app_id'
  | 'counter'
  | 'environment'
  | 'credential_id';

export type AttestationResult =
  | { ok: true; publicKey: Uint8Array; environment: AttestEnvironment }
  | { ok: false; reason: AttestationFailure };

let appleRoot: Uint8Array | null = null;
const appleRootDer = (): Uint8Array => (appleRoot ??= pemToDer(APPLE_APP_ATTESTATION_ROOT_CA));

/**
 * Apple's validation, in its order: the certificate chain to the root (each link signed by a CA,
 * every certificate valid now), the nonce in the credential certificate equal to
 * SHA256(authData || clientDataHash), the key id equal to SHA256 of the certificate's key, the
 * rpIdHash this app's, the counter 0, the aaguid production (or the sandbox when allowed), and the
 * credential id the key id. On success, the key's EC point and the environment.
 */
export async function verifyAttestation(input: AttestationInput, cfg: VerifyConfig): Promise<AttestationResult> {
  const fail = (reason: AttestationFailure): AttestationResult => ({ ok: false, reason });
  const keyId = KEY_ID_PATTERN.test(input.keyId) ? fromBase64(input.keyId, 32) : null;
  const bytes = fromBase64(input.attestation, MAX_ATTESTATION_BYTES);
  if (!keyId || keyId.length !== 32 || !bytes || input.clientDataHash.length !== 32) return fail('malformed');

  let certs: Certificate[];
  let root: Certificate;
  let authData: Uint8Array;
  let auth: AuthData;
  try {
    const obj = decodeCbor(bytes);
    if (field(obj, 'fmt') !== 'apple-appattest') return fail('format');
    const x5c = field(field(obj, 'attStmt') ?? null, 'x5c');
    const ad = field(obj, 'authData');
    if (!Array.isArray(x5c) || x5c.length < 2 || x5c.length > 4 || !x5c.every((c) => c instanceof Uint8Array) || !(ad instanceof Uint8Array)) {
      return fail('format');
    }
    certs = (x5c as Uint8Array[]).map(parseCertificate);
    root = parseCertificate(cfg.root ?? appleRootDer());
    authData = ad;
    auth = parseAuthData(ad, true);
  } catch (err) {
    if (err instanceof Malformed || err instanceof TypeError) return fail('malformed');
    throw err;
  }

  // 1. the chain: credCert ← intermediate (← …) ← the root, every certificate valid now
  for (const c of [...certs, root]) {
    if (cfg.now < c.notBefore || cfg.now > c.notAfter) return fail('expired');
  }
  for (let k = 0; k < certs.length; k++) {
    if (!(await signedBy(certs[k], certs[k + 1] ?? root))) return fail('chain');
  }
  const leaf = certs[0];
  if (leaf.ca || leaf.curve !== 'P-256') return fail('chain');

  // 2–4. the nonce: SHA256(authData || clientDataHash), in the credential certificate's extension
  const nonce = await sha256(authData, input.clientDataHash);
  const ext = leaf.extensions.get(OIDS.appleNonce);
  let certNonce: Uint8Array | null = null;
  try {
    const tagged = ext ? childrenOf(readOne(ext, SEQUENCE))[0] : undefined;
    if (tagged?.tag === 0xa1) certNonce = readOne(tagged.value, OCTET_STRING).value;
  } catch {
    certNonce = null;
  }
  if (!certNonce || !equalBytes(certNonce, nonce)) return fail('nonce');

  // 5. the key id is SHA256 of the credential certificate's key
  if (!equalBytes(await sha256(leaf.point), keyId)) return fail('key_id');
  // 6. this app
  if (!equalBytes(auth.rpIdHash, cfg.rpIdHash)) return fail('app_id');
  // 7. a fresh key has signed nothing yet
  if (auth.counter !== 0) return fail('counter');
  // 8. production, or the sandbox when allowed
  const aaguid = new TextDecoder().decode(auth.aaguid ?? new Uint8Array());
  const environment: AttestEnvironment | null =
    aaguid === AAGUID.production ? 'production' : aaguid === AAGUID.development && cfg.allowDevelopment ? 'development' : null;
  if (!environment) return fail('environment');
  // 9. the credential is the key
  if (!auth.credentialId || !equalBytes(auth.credentialId, keyId)) return fail('credential_id');

  return { ok: true, publicKey: leaf.point.slice(), environment };
}

// ---------------------------------------------------------------------------
// assertion
// ---------------------------------------------------------------------------

export interface AssertionInput {
  /** The assertion object (base64). */
  assertion: string;
  /** The exact bytes the phone signed (an upload's request body). */
  clientData: Uint8Array;
  /** The attested key's uncompressed P-256 point. */
  publicKey: Uint8Array;
  /** The highest counter this key has used so far. */
  counter: number;
}

export type AssertionFailure = 'malformed' | 'signature' | 'app_id' | 'counter';
export type AssertionResult = { ok: true; counter: number } | { ok: false; reason: AssertionFailure };

/**
 * Apple's assertion checks: the signature, by the stored key, over
 * SHA256(authenticatorData || SHA256(clientData)); the rpIdHash this app's; the counter above the
 * stored one. On success, the new counter (the caller stores it).
 */
export async function verifyAssertion(input: AssertionInput, cfg: Pick<VerifyConfig, 'rpIdHash'>): Promise<AssertionResult> {
  const fail = (reason: AssertionFailure): AssertionResult => ({ ok: false, reason });
  const bytes = fromBase64(input.assertion, MAX_ASSERTION_BYTES);
  if (!bytes || input.publicKey.length !== 65 || input.publicKey[0] !== 0x04) return fail('malformed');
  let signature: Cbor | undefined;
  let authData: Cbor | undefined;
  let auth: AuthData;
  try {
    const obj = decodeCbor(bytes);
    signature = field(obj, 'signature');
    authData = field(obj, 'authenticatorData');
    if (!(signature instanceof Uint8Array) || !(authData instanceof Uint8Array)) return fail('malformed');
    auth = parseAuthData(authData, false);
  } catch (err) {
    if (err instanceof Malformed || err instanceof TypeError) return fail('malformed');
    throw err;
  }

  const nonce = await sha256(authData, await sha256(input.clientData));
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('raw', concat(input.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    return fail('malformed');
  }
  if (!(await verifyEcdsa(key, 'P-256', 'SHA-256', signature, nonce))) return fail('signature');
  if (!equalBytes(auth.rpIdHash, cfg.rpIdHash)) return fail('app_id');
  if (!(auth.counter > input.counter)) return fail('counter');
  return { ok: true, counter: auth.counter };
}

// ---------------------------------------------------------------------------
// configuration: the functions' secrets
// ---------------------------------------------------------------------------

/** What the verifiers need from the secrets. */
export interface AttestSettings {
  /** `appIdHash(APP_ATTEST_TEAM_ID, APP_ATTEST_BUNDLE_ID or BUNDLE_ID)`. */
  rpIdHash: Uint8Array;
  /** APP_ATTEST_ALLOW_DEVELOPMENT=true: keys from Apple's sandbox are accepted (and their assertions). */
  allowDevelopment: boolean;
  /** A test's own trust anchor (DER); Apple's root when absent, as it always is outside tests. */
  root?: Uint8Array;
}

/** An Apple team id: 10 capital letters and digits. */
export const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

/**
 * The settings from the secrets, or null when App Attest is not configured: APP_ATTEST_TEAM_ID unset,
 * or not a team id (said once in the log). Nothing is verified without one.
 */
export async function attestSettingsFromEnv(get: (name: string) => string | undefined, log?: { error(...args: unknown[]): void }): Promise<AttestSettings | null> {
  const teamId = get('APP_ATTEST_TEAM_ID')?.trim();
  if (!teamId) return null;
  if (!TEAM_ID_PATTERN.test(teamId)) {
    log?.error('APP_ATTEST_TEAM_ID is not a 10-character Apple team id: App Attest is off');
    return null;
  }
  const bundleId = get('APP_ATTEST_BUNDLE_ID')?.trim() || BUNDLE_ID;
  return { rpIdHash: await appIdHash(teamId, bundleId), allowDevelopment: get('APP_ATTEST_ALLOW_DEVELOPMENT') === 'true' };
}

/** APP_ATTEST_ENFORCE=true: an iPhone upload counts only with a valid assertion. */
export const attestEnforced = (get: (name: string) => string | undefined): boolean => get('APP_ATTEST_ENFORCE') === 'true';

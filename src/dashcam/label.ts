// A DashPal's pairing code as text and as a link (docs/BLE_PROTOCOL.md §2 Security).
//
// The code is 16 bytes `S` and a check byte, as Crockford base32 (28 characters, the last 4 padding
// bits zero), shown in 7 groups of 4. The check byte tells its kind: the label code under the mount
// (`SHA-256("DashPal code v1" || S)[0]`) or a one-time code of Add another phone
// (`SHA-256("DashPal once v1" || S)[0]`); a one-time code is drawn again until its two check bytes
// differ, so every code text is exactly one kind (the label kind wins a tie, as on the dashcam).
// Typed input is case-insensitive, ignores spaces and dashes, reads I and L as 1 and O as 0, and
// refuses U.
//
// The label's QR code is `https://<LINK_DOMAIN>/dashpal#d=<dashcam_id>&k=<code>`: an App Link /
// Universal Link only the signed RoadWise app opens, its parameters in the fragment so a browser
// never sends them to a server. `roadwise://dashpal` (the app's own links) is read too; a screen
// never shows one with a code. `LINK_DOMAIN` is the build's `extra.linkDomain`.
import { concat, randomBytes, sha256, utf8 } from './crypto';
import { isDashcamId } from './protocol';

export type CodeKind = 'label' | 'once';

export interface PairingCode {
  /** the 16 code bytes */
  S: Uint8Array;
  kind: CodeKind;
}

/** A DashPal link, parsed: `d` the dashcam id (lowercase), `code` when it carries one. */
export interface DashpalLinkParts {
  d: string | null;
  code: PairingCode | null;
}

export const CODE_BYTES = 16;
export const CODE_CHARS = 28;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function checkByte(S: Uint8Array, kind: CodeKind): number {
  return sha256(utf8(kind === 'once' ? 'DashPal once v1' : 'DashPal code v1'), S)[0]!;
}

/** The 28 code characters (no dashes) of `S` and its check byte. */
function symbols(S: Uint8Array, kind: CodeKind): string {
  const raw = concat(S, [checkByte(S, kind)]);
  let acc = 0;
  let bits = 0;
  let out = '';
  for (const b of raw) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // the last bit and 4 zero padding bits
  out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out;
}

/** The code text, in 7 groups of 4 joined by dashes (`dashes: false`: 28 characters, as in a link). */
export function formatCode(S: Uint8Array, kind: CodeKind, opts: { dashes?: boolean } = {}): string {
  const s = symbols(S, kind);
  return opts.dashes === false ? s : (s.match(/.{4}/g) ?? []).join('-');
}

/** A typed or scanned code text as its bytes and kind, or null (refused before anything is sent). */
export function parseCode(text: string): PairingCode | null {
  const sym: number[] = [];
  for (const raw of text.toUpperCase()) {
    if (raw === ' ' || raw === '-') continue;
    const ch = raw === 'I' || raw === 'L' ? '1' : raw === 'O' ? '0' : raw;
    const v = CROCKFORD.indexOf(ch);
    if (v < 0 || ch.length !== 1) return null;
    sym.push(v);
    if (sym.length > CODE_CHARS) return null;
  }
  if (sym.length !== CODE_CHARS) return null;
  const out = new Uint8Array(17);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const v of sym) {
    acc = ((acc << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8 && o < 17) {
      out[o++] = (acc >> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  if (o !== 17 || (acc & ((1 << bits) - 1)) !== 0) return null;
  const S = out.slice(0, CODE_BYTES);
  const c = out[16]!;
  if (c === checkByte(S, 'label')) return { S, kind: 'label' };
  if (c === checkByte(S, 'once')) return { S, kind: 'once' };
  return null;
}

/** `DashPal-XXXX`: the last 4 hex characters of the dashcam id, upper case. */
export const nameOf = (dashcamId: string): string => `DashPal-${dashcamId.slice(-4).toUpperCase()}`;

/** A hostname as the build's link domain (lowercase), or '' when it is not one. */
export function normaliseDomain(domain: unknown): string {
  if (typeof domain !== 'string') return '';
  const d = domain.trim().toLowerCase();
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d) ? d : '';
}

/** The build's link domain (`app.config.ts` `extra.linkDomain`); '' when none is set. */
export function linkDomain(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: expo-constants
    const Constants = (require('expo-constants') as { default: { expoConfig?: { extra?: Record<string, unknown> } | null } }).default;
    return normaliseDomain(Constants.expoConfig?.extra?.linkDomain);
  } catch {
    return '';
  }
}

/** The https link of a code (a QR code's content). */
export const dashpalLink = (dashcamId: string, code: PairingCode, domain: string = linkDomain()): string =>
  `https://${domain}/dashpal#d=${dashcamId}&k=${formatCode(code.S, code.kind, { dashes: false })}`;

/** The `d=…&k=…` pairs of a fragment or query (the first of each name wins). */
function params(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of text.split('&')) {
    if (pair.length === 0) continue;
    const i = pair.indexOf('=');
    const k = (i < 0 ? pair : pair.slice(0, i)).toLowerCase();
    let v = i < 0 ? '' : pair.slice(i + 1);
    try {
      v = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      v = '\u0000';
    }
    if (!out.has(k)) out.set(k, v);
  }
  return out;
}

/**
 * A DashPal link (the label's https link on `domain`, or `roadwise://dashpal`), or `'not_a_code'`
 * for anything else, an invalid `d` and an invalid `k` included. The bare link has neither part.
 */
export function parseDashpalLink(url: string, domain: string = linkDomain()): DashpalLinkParts | 'not_a_code' {
  const text = url.trim();
  let rest: string;
  const https = /^https:\/\/([^/?#]+)(\/[^?#]*)?([?#].*)?$/i.exec(text);
  if (https) {
    const host = https[1]!.toLowerCase();
    if (domain.length === 0 || host !== domain) return 'not_a_code';
    const p = https[2] ?? '';
    if (p !== '/dashpal' && p !== '/dashpal/') return 'not_a_code';
    rest = https[3] ?? '';
  } else {
    // roadwise://dashpal, roadwise:///dashpal, roadwise:dashpal
    const custom = /^roadwise:(?:\/\/\/?)?dashpal\/?([?#].*)?$/i.exec(text);
    if (!custom) return 'not_a_code';
    rest = custom[1] ?? '';
  }
  // A fragment or a query (or both: the fragment wins, as the label uses it).
  const hash = rest.indexOf('#');
  const query = hash >= 0 ? rest.slice(0, hash) : rest;
  const fragment = hash >= 0 ? rest.slice(hash + 1) : '';
  const fromFragment = params(fragment);
  const fromQuery = params(query.replace(/^\?/, ''));
  const get = (k: string): string | undefined => fromFragment.get(k) ?? fromQuery.get(k);
  const dRaw = get('d');
  const kRaw = get('k');
  let d: string | null = null;
  if (dRaw !== undefined) {
    if (!/^[0-9a-fA-F]{12}$/.test(dRaw)) return 'not_a_code';
    d = dRaw.toLowerCase();
    if (!isDashcamId(d)) return 'not_a_code';
  }
  let code: PairingCode | null = null;
  if (kRaw !== undefined) {
    code = parseCode(kRaw);
    if (!code) return 'not_a_code';
  }
  return { d, code };
}

/**
 * A fresh one-time code for Add another phone: 16 random bytes, drawn again while all zero or while
 * its two check bytes agree, so its text is only ever the `once` kind.
 */
export function drawOnceCode(rand: (n: number) => Uint8Array = randomBytes): PairingCode {
  for (;;) {
    const S = rand(CODE_BYTES);
    if (S.length === CODE_BYTES && S.some((b) => b !== 0) && checkByte(S, 'label') !== checkByte(S, 'once')) return { S, kind: 'once' };
  }
}

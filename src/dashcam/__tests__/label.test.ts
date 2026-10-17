// The pairing code's text and link, against the shared vectors (v2.code, v2.link) and the rules of
// docs/BLE_PROTOCOL.md §2 Security.
import vectors from '../__fixtures__/ble_vectors.json';
import { checkByte, dashpalLink, drawOnceCode, formatCode, normaliseDomain, parseCode, parseDashpalLink } from '../label';
import { fromHex, nameOf, toHex } from '../protocol';

interface CodeVec {
  S: string;
  kind: 'label' | 'once';
  check: number;
  text: string;
}
const V = (vectors as unknown as { v2: { code: { label: CodeVec; once: CodeVec; aliases: string[]; invalid: { text: string; reason: string }[] }; link: { domain: string; valid: { url: string; d: string | null; S: string | null; kind: string | null }[]; invalid: string[] } } }).v2;
const bytes = (hex: string): Uint8Array => Uint8Array.from(fromHex(hex));
const DOMAIN = V.link.domain;

describe('the code text', () => {
  test.each([V.code.label, V.code.once])('the $kind vector: check byte, text with dashes and without, and back', (v) => {
    const S = bytes(v.S);
    expect(checkByte(S, v.kind)).toBe(v.check);
    expect(formatCode(S, v.kind)).toBe(v.text);
    expect(formatCode(S, v.kind, { dashes: false })).toBe(v.text.replace(/-/g, ''));
    const back = parseCode(v.text);
    expect(back && toHex(back.S)).toBe(v.S);
    expect(back?.kind).toBe(v.kind);
  });

  test('the accepted aliases (lower case, no dashes, spaces, I/L/O) all read as the label code', () => {
    for (const a of V.code.aliases) {
      const c = parseCode(a);
      expect(c && toHex(c.S)).toBe(V.code.label.S);
      expect(c?.kind).toBe('label');
    }
  });

  test('the refused texts (a check byte of neither kind, U, 27 characters, padding bits set) are refused', () => {
    for (const bad of V.code.invalid) expect(parseCode(bad.text)).toBeNull();
    expect(parseCode(`${V.code.label.text}0`)).toBeNull(); // 29
    expect(parseCode('')).toBeNull();
    expect(parseCode('000G-40R4-0M30-E209-185G-R38E-1W6*')).toBeNull();
  });

  test('a tie of both check bytes reads as the label kind (as on the dashcam)', () => {
    // Search a code whose two check bytes agree (about 1 in 256) and confirm the label kind wins.
    let S: Uint8Array | null = null;
    for (let i = 0; i < 100_000 && !S; i++) {
      const c = new Uint8Array(16);
      c[0] = i & 0xff;
      c[1] = (i >> 8) & 0xff;
      c[2] = (i >> 16) & 0xff;
      if (checkByte(c, 'label') === checkByte(c, 'once')) S = c;
    }
    expect(S).not.toBeNull();
    expect(parseCode(formatCode(S!, 'label'))?.kind).toBe('label');
  });
});

describe('drawOnceCode', () => {
  test('never yields a code whose text also reads as a label code, nor an all-zero one (1000 draws, forced collisions)', () => {
    // A source that repeats a tie and the zero code before each fresh draw.
    let tie: Uint8Array | null = null;
    for (let i = 0; !tie; i++) {
      const c = new Uint8Array(16);
      c[0] = i & 0xff;
      c[1] = (i >> 8) & 0xff;
      if (checkByte(c, 'label') === checkByte(c, 'once')) tie = c;
    }
    let n = 0;
    const rand = (len: number): Uint8Array => {
      n += 1;
      if (n % 3 === 1) return tie!.slice(0, len);
      if (n % 3 === 2) return new Uint8Array(len);
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = (n * 131 + i * 17) & 0xff;
      return out;
    };
    for (let k = 0; k < 1000; k++) {
      const code = drawOnceCode(rand);
      expect(code.kind).toBe('once');
      expect(code.S.some((b) => b !== 0)).toBe(true);
      expect(parseCode(formatCode(code.S, 'once'))?.kind).toBe('once');
      expect(checkByte(code.S, 'label')).not.toBe(checkByte(code.S, 'once'));
    }
  });

  test('draws from the secure source by default', () => {
    expect(drawOnceCode().S).toHaveLength(16);
  });
});

describe('links', () => {
  test.each(V.link.valid)('$url parses', (v) => {
    const got = parseDashpalLink(v.url, DOMAIN);
    expect(got).not.toBe('not_a_code');
    if (got === 'not_a_code') return;
    expect(got.d).toBe(v.d);
    expect(got.code ? toHex(got.code.S) : null).toBe(v.S);
    expect(got.code?.kind ?? null).toBe(v.kind);
  });

  test.each(V.link.invalid)('%s is not a DashPal code', (url) => {
    expect(parseDashpalLink(url, DOMAIN)).toBe('not_a_code');
  });

  test('the label link round trips, the dashcam id is read in any case, and k in any case and with dashes', () => {
    const code = { S: bytes(V.code.label.S), kind: 'label' as const };
    const url = dashpalLink('f412fa0c9e01', code, DOMAIN);
    expect(url).toBe(V.link.valid[0]!.url);
    const upper = parseDashpalLink(`https://PAIR.example.com/dashpal#d=F412FA0C9E01&k=${V.code.label.text.toLowerCase()}`, DOMAIN);
    expect(upper !== 'not_a_code' && upper.d).toBe('f412fa0c9e01');
    expect(upper !== 'not_a_code' && upper.code && toHex(upper.code.S)).toBe(V.code.label.S);
  });

  test('a query works like the fragment; roadwise://dashpal with or without parts; d without k; the bare link', () => {
    const q = parseDashpalLink(`https://${DOMAIN}/dashpal?d=f412fa0c9e01&k=000G40R40M30E209185GR38E1W60`, DOMAIN);
    expect(q !== 'not_a_code' && q.code?.kind).toBe('label');
    expect(parseDashpalLink('roadwise://dashpal', DOMAIN)).toEqual({ d: null, code: null });
    expect(parseDashpalLink('roadwise:///dashpal?d=f412fa0c9e01', DOMAIN)).toEqual({ d: 'f412fa0c9e01', code: null });
    const custom = parseDashpalLink('roadwise://dashpal#d=f412fa0c9e01&k=C944BA9XVGR6PTJDKBQ2BR9W54RG', DOMAIN);
    expect(custom !== 'not_a_code' && custom.code?.kind).toBe('once');
    expect(parseDashpalLink(`https://${DOMAIN}/dashpal#d=f412fa0c9e01`, DOMAIN)).toEqual({ d: 'f412fa0c9e01', code: null });
    expect(parseDashpalLink(`https://${DOMAIN}/dashpal`, DOMAIN)).toEqual({ d: null, code: null });
  });

  test('other schemes, hosts, paths, a friend code, junk and a build with no link domain are not DashPal codes', () => {
    for (const url of [
      'roadwise://add/someone',
      'http://pair.example.com/dashpal#d=f412fa0c9e01',
      'https://pair.example.com.evil.com/dashpal#d=f412fa0c9e01',
      'https://evil.com/pair.example.com/dashpal',
      'https://pair.example.com/dashpalx',
      'otherapp://dashpal?d=f412fa0c9e01',
      'roadwise://dashpal?d=f412fa0c9e01&k=000G40R40M30E209185GR38E1W6U',
      'roadwise://dashpal?d=zz12fa0c9e01',
      'hello',
      '',
    ]) {
      expect(parseDashpalLink(url, DOMAIN)).toBe('not_a_code');
    }
    expect(parseDashpalLink(V.link.valid[0]!.url, '')).toBe('not_a_code');
    // The app's own scheme still works without a domain.
    expect(parseDashpalLink('roadwise://dashpal?d=f412fa0c9e01', '')).toEqual({ d: 'f412fa0c9e01', code: null });
  });

  test('the name and the domain rule', () => {
    expect(nameOf('f412fa0c9e01')).toBe('DashPal-9E01');
    expect(normaliseDomain(' Pair.Example.COM ')).toBe('pair.example.com');
    for (const bad of ['', 'localhost', 'a/b.com', 'https://x.com', 'x..com', 42, null]) expect(normaliseDomain(bad)).toBe('');
  });
});

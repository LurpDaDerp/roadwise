// The fail-closed privacy gate (v3): the camera may run only while all four inputs hold; every input
// applies at once; the token is minted only here, from an injected random source.
import { createGate, gateClosedReason, type DmsGate, type GateToken, type PermissionStatus } from '../gate';

const OPEN: DmsGate = { enabled: true, driveActive: true, appActive: true };
const counter = () => {
  let n = 0;
  return () => `nonce-${++n}`;
};

describe('every combination of the four inputs (open iff all hold)', () => {
  const bools = [true, false] as const;
  const perms = ['granted', 'denied', 'undetermined'] as const;
  test('24 combinations (3 booleans × the permission)', () => {
    let opened = 0;
    let n = 0;
    for (const enabled of bools)
      for (const driveActive of bools)
        for (const appActive of bools)
          for (const permission of perms) {
            n++;
            const g: DmsGate = { enabled, driveActive, appActive };
            const want = enabled && driveActive && appActive && permission === 'granted';
            const r = createGate(counter()).gateOpen(g, permission);
            expect({ g, permission, open: r.open }).toEqual({ g, permission, open: want });
            expect(gateClosedReason(g, permission) === null).toBe(want);
            if (r.open) opened++;
          }
    expect(n).toBe(24);
    expect(opened).toBe(1);
  });
  test('each closed input names itself, in the fixed order', () => {
    const p: PermissionStatus = 'granted';
    expect(gateClosedReason({ ...OPEN, enabled: false }, p)).toBe('disabled');
    expect(gateClosedReason({ ...OPEN, driveActive: false }, p)).toBe('no_drive');
    expect(gateClosedReason({ ...OPEN, appActive: false }, p)).toBe('app_inactive');
    expect(gateClosedReason(OPEN, 'undetermined')).toBe('permission');
    expect(gateClosedReason(OPEN, 'denied')).toBe('permission');
    expect(gateClosedReason({ enabled: false, driveActive: false, appActive: false }, 'denied')).toBe('disabled');
  });
  test('an unknown value is closed (nothing but literal true opens)', () => {
    expect(gateClosedReason({ ...OPEN, enabled: undefined as unknown as boolean }, 'granted')).toBe('disabled');
    expect(gateClosedReason({ ...OPEN, appActive: 1 as unknown as boolean }, 'granted')).toBe('app_inactive');
  });
});

describe('user and OS inputs apply at once', () => {
  test.each([
    ['DMS turned off', { enabled: false }, 'granted'],
    ['the drive ended', { driveActive: false }, 'granted'],
    ['the app backgrounded', { appActive: false }, 'granted'],
    ['the permission revoked', {}, 'denied'],
  ] as const)('%s closes the open gate on the next evaluation', (_n, change, permission) => {
    const gate = createGate(counter());
    expect(gate.gateOpen(OPEN, 'granted').open).toBe(true);
    expect(gate.gateOpen({ ...OPEN, ...change }, permission).open).toBe(false);
  });
});

describe('the gate token', () => {
  test('minted on each closed → open edge from the injected source, kept while open', () => {
    const gate = createGate(counter());
    const t1 = gate.gateOpen(OPEN, 'granted');
    expect(gate.gateOpen(OPEN, 'granted')).toEqual(t1);
    gate.gateOpen({ ...OPEN, appActive: false }, 'granted');
    const t2 = gate.gateOpen(OPEN, 'granted');
    expect(t1).toEqual({ open: true, token: 'nonce-1' });
    expect(t2).toEqual({ open: true, token: 'nonce-2' });
  });
  test('an empty nonce is refused (native rejects an empty token)', () => {
    expect(() => createGate(() => '').gateOpen(OPEN, 'granted')).toThrow(/nonce/);
  });
  test('a token is not constructible outside gate.ts (a type test, checked by npm run typecheck)', () => {
    // @ts-expect-error a plain string is not a GateToken
    const forged: GateToken = 'forged';
    const r = createGate(counter()).gateOpen(OPEN, 'granted');
    const real: GateToken | null = r.open ? r.token : null;
    expect(typeof forged).toBe('string');
    expect(real).toBe('nonce-1');
  });
});

describe('check(): the pre-check without a mint (the host, before any native call)', () => {
  test('it reports the closing input and mints nothing; a close forgets the token', () => {
    let minted = 0;
    const gate = createGate(() => `nonce-${++minted}`);
    expect(gate.check(OPEN, 'granted')).toBeNull();
    expect(minted).toBe(0);
    expect(gate.check({ ...OPEN, appActive: false }, 'granted')).toBe('app_inactive');
    expect(gate.gateOpen(OPEN, 'granted')).toEqual({ open: true, token: 'nonce-1' });
    expect(gate.check({ ...OPEN, driveActive: false }, 'granted')).toBe('no_drive');
    expect(gate.gateOpen(OPEN, 'granted')).toEqual({ open: true, token: 'nonce-2' });
  });
});

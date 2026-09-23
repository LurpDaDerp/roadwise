// The fail-closed privacy gate (plan Global Constraints "Privacy (hard)", Task 13, rev1 S-M1/S-M4): the
// camera may run only while all eight inputs hold; the remote flag is read at drive start only; user and
// OS inputs apply at once; the token is minted only here, from an injected random source.
import { createGate, gateClosedReason, type DmsGate, type GateToken, type PermissionStatus } from '../gate';

const OPEN: DmsGate = { optedIn: true, cameraBeta: true, ageBand: '18_plus', driveActive: true, mode: 'mounted', role: 'driver', appActive: true };
const counter = () => {
  let n = 0;
  return () => `nonce-${++n}`;
};

describe('every combination of the eight inputs (open iff all hold; unknown age closes)', () => {
  const bools = [true, false] as const;
  const ages = ['18_plus', 'other', 'unknown'] as const;
  const modes = ['mounted', 'pocket', 'auto'] as const;
  const roles = ['driver', 'passenger', 'unknown'] as const;
  const perms = ['granted', 'denied', 'undetermined'] as const;
  test('1296 combinations (4 booleans × 4 three-way inputs)', () => {
    let opened = 0;
    let n = 0;
    for (const optedIn of bools)
      for (const cameraBeta of bools)
        for (const ageBand of ages)
          for (const driveActive of bools)
            for (const mode of modes)
              for (const role of roles)
                for (const appActive of bools)
                  for (const permission of perms) {
                    n++;
                    const g: DmsGate = { optedIn, cameraBeta, ageBand, driveActive, mode, role, appActive };
                    const want = optedIn && cameraBeta && ageBand === '18_plus' && driveActive && mode === 'mounted' && role === 'driver' && appActive && permission === 'granted';
                    const r = createGate(counter()).gateOpen(g, permission);
                    expect({ g, permission, open: r.open }).toEqual({ g, permission, open: want });
                    expect(gateClosedReason(g, permission) === null).toBe(want);
                    if (r.open) opened++;
                  }
    expect(n).toBe(1296);
    expect(opened).toBe(1);
  });
  test('each closed input names itself', () => {
    const p: PermissionStatus = 'granted';
    expect(gateClosedReason({ ...OPEN, optedIn: false }, p)).toBe('not_opted_in');
    expect(gateClosedReason({ ...OPEN, cameraBeta: false }, p)).toBe('flag_off');
    expect(gateClosedReason({ ...OPEN, ageBand: 'unknown' }, p)).toBe('age');
    expect(gateClosedReason({ ...OPEN, ageBand: 'other' }, p)).toBe('age');
    expect(gateClosedReason({ ...OPEN, driveActive: false }, p)).toBe('no_drive');
    expect(gateClosedReason({ ...OPEN, mode: 'auto' }, p)).toBe('mode');
    expect(gateClosedReason({ ...OPEN, role: 'unknown' }, p)).toBe('role');
    expect(gateClosedReason({ ...OPEN, appActive: false }, p)).toBe('app_inactive');
    expect(gateClosedReason(OPEN, 'undetermined')).toBe('permission');
  });
});

describe('the remote flag is read at drive start only (standing rule)', () => {
  test('a flag withdrawn mid-drive keeps the drive running, with the same token; the next drive is closed', () => {
    const gate = createGate(counter());
    const a = gate.gateOpen(OPEN, 'granted');
    const b = gate.gateOpen({ ...OPEN, cameraBeta: false }, 'granted');
    expect(a).toEqual({ open: true, token: 'nonce-1' });
    expect(b).toEqual(a);
    gate.gateOpen({ ...OPEN, cameraBeta: false, driveActive: false }, 'granted');
    expect(gate.gateOpen({ ...OPEN, cameraBeta: false }, 'granted')).toEqual({ open: false, reason: 'flag_off' });
  });
  test('a flag turned on mid-drive waits for the next drive too', () => {
    const gate = createGate(counter());
    expect(gate.gateOpen({ ...OPEN, cameraBeta: false }, 'granted')).toEqual({ open: false, reason: 'flag_off' });
    expect(gate.gateOpen(OPEN, 'granted')).toEqual({ open: false, reason: 'flag_off' });
    gate.gateOpen({ ...OPEN, driveActive: false }, 'granted');
    expect(gate.gateOpen(OPEN, 'granted').open).toBe(true);
  });
});

describe('user and OS inputs apply at once (rev1 S-M4)', () => {
  test.each([
    ['opt-out', { optedIn: false }, 'granted'],
    ['a passenger', { role: 'passenger' }, 'granted'],
    ['pocket mode', { mode: 'pocket' }, 'granted'],
    ['the app backgrounded', { appActive: false }, 'granted'],
    ['the permission revoked', {}, 'denied'],
  ] as const)('%s closes the open gate on the next evaluation', (_n, change, permission) => {
    const gate = createGate(counter());
    expect(gate.gateOpen(OPEN, 'granted').open).toBe(true);
    expect(gate.gateOpen({ ...OPEN, ...change }, permission).open).toBe(false);
  });
});

describe('the gate token (rev1 S-M1)', () => {
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

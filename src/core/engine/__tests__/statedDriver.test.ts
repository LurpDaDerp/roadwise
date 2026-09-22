/** @jest-environment node */
// Final review M4 and M10c: "I'm driving now" is a statement finalize acts on, and the start has
// one fact (its evidence) from which the coarse source is derived.
import { decideRole } from '@/core/engine/finalize';
import { createSession, startSourceFor } from '@/core/engine/session';

const T0 = 1_700_000_000_000;

describe('decideRole with a stated driver (M4)', () => {
  const auto = (over: { role?: 'driver' | 'passenger'; statedDriver?: boolean } = {}) => ({
    role: over.role ?? ('driver' as const),
    startEvidence: 'auto' as const,
    statedDriver: over.statedDriver,
  });

  test('an auto trip the driver said they were driving is decided as a manual start: driver', () => {
    expect(decideRole(auto({ statedDriver: true }), [], [], { rolePrior: 0.5 }).role).toBe('driver');
  });

  test('negative control: the same trip without the statement, on a neutral prior, is unknown', () => {
    expect(decideRole(auto(), [], [], { rolePrior: 0.5 }).role).toBe('unknown');
  });

  test('a later switch back to passenger wins over an earlier statement', () => {
    expect(decideRole(auto({ role: 'passenger', statedDriver: true }), [], [], { rolePrior: 0.9 }).role).toBe(
      'passenger'
    );
  });
});

describe('the start has one fact (M10c)', () => {
  test('startSource is derived from the evidence, never set independently', () => {
    expect(startSourceFor('tap')).toBe('manual');
    expect(startSourceFor('movingStart')).toBe('manual');
    expect(startSourceFor('auto')).toBe('auto');
    const s = createSession({
      clientTripId: 't',
      mode: 'auto',
      role: 'driver',
      startSource: 'auto',
      startEvidence: 'movingStart',
      startedAt: T0,
    });
    expect(s).toMatchObject({ startEvidence: 'movingStart', startSource: 'manual' });
  });

  test('a caller that gives only the coarse source still gets both', () => {
    const s = createSession({ clientTripId: 't', mode: 'mounted', role: 'driver', startSource: 'manual', startedAt: T0 });
    expect(s).toMatchObject({ startEvidence: 'tap', startSource: 'manual' });
  });
});

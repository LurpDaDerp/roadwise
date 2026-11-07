/** @jest-environment node */
import { QueryClient, QueryObserver } from '@tanstack/react-query';

import { createQueryClient } from '@/data/queries/client';
import { invalidateAfterSync } from '@/data/queries/invalidate';

/** The settings-backed caches the screens fill: none of them is keyed by a uid. */
const SETTINGS_KEYS = [
  ['places', 'saved'],
  ['places', 'learned'],
  ['places', 'suggestions', 'home', 'k'],
  ['places', 'prompt', 'trip-1'],
  ['emergency', 'contacts'],
  ['permit', 'prefs'],
] as const;

function seeded(): QueryClient {
  const qc = createQueryClient();
  for (const key of SETTINGS_KEYS) qc.setQueryData(key, { owner: 'driver A' });
  qc.setQueryData(['drives', 'recent', 5], ['a drive']);
  qc.setQueryData(['notificationPrefs'], { quiet: true });
  return qc;
}

describe('invalidateAfterSync', () => {
  test("a wipe empties the places, emergency contacts and Permit caches: no screen paints the leaving driver's", async () => {
    const qc = seeded();
    await invalidateAfterSync(qc, { source: 'wipe' });
    for (const key of SETTINGS_KEYS) expect({ key, data: qc.getQueryData(key) }).toEqual({ key, data: undefined });
    // The drive lists are invalidated as before (kept until refetched); the rest is not touched.
    expect(qc.getQueryState(['drives', 'recent', 5])?.isInvalidated).toBe(true);
    expect(qc.getQueryData(['notificationPrefs'])).toEqual({ quiet: true });
    qc.clear();
  });

  test('a wipe refetches a settings cache a mounted screen still observes', async () => {
    const qc = createQueryClient();
    let reads = 0;
    const queryFn = async () => ((reads += 1) === 1 ? [{ name: 'Mom' }] : []);
    const observer = new QueryObserver(qc, { queryKey: ['emergency', 'contacts'], queryFn });
    const seen: unknown[] = [];
    const off = observer.subscribe((r) => {
      if (r.status === 'success') seen.push(r.data);
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(qc.getQueryData(['emergency', 'contacts'])).toEqual([{ name: 'Mom' }]);
    await invalidateAfterSync(qc, { source: 'wipe' });
    await new Promise((r) => setTimeout(r, 0));
    expect(qc.getQueryData(['emergency', 'contacts'])).toEqual([]);
    expect(reads).toBe(2);
    off();
    qc.clear();
  });

  test('any other change leaves the settings caches alone', async () => {
    for (const source of ['sync', 'finalize', 'hydrate', 'spots'] as const) {
      const qc = seeded();
      await invalidateAfterSync(qc, { source });
      for (const key of SETTINGS_KEYS) expect({ source, key, data: qc.getQueryData(key) }).toEqual({ source, key, data: { owner: 'driver A' } });
      qc.clear();
    }
  });
});

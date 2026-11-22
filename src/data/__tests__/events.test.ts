/** @jest-environment node */
import { emitDataChanged, onDataChanged, type DataChange } from '@/data/events';

/** Everything heard by one listener over one emit burst, delivered on the next macrotask. */
async function heard(burst: () => void): Promise<DataChange[]> {
  const got: DataChange[] = [];
  const off = onDataChanged((c) => got.push(c));
  try {
    burst();
    expect(got).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    return got;
  } finally {
    off();
  }
}

test('a burst of the same bare event is delivered once; sync events carry their counts and are each delivered', async () => {
  expect(
    await heard(() => {
      emitDataChanged({ source: 'enqueue' });
      emitDataChanged({ source: 'enqueue' });
      emitDataChanged({ source: 'sync', result: { done: 1, failed: 0, deferred: 0 } });
      emitDataChanged({ source: 'sync', result: { done: 0, failed: 1, deferred: 0 } });
    })
  ).toEqual([{ source: 'enqueue' }, { source: 'sync', result: { done: 1, failed: 0, deferred: 0 } }, { source: 'sync', result: { done: 0, failed: 1, deferred: 0 } }]);
});

test('a change whose writer refreshed the cache itself keeps its mark when nothing else of its source joins it', async () => {
  expect(await heard(() => emitDataChanged({ source: 'enqueue', cacheRefreshed: true }))).toEqual([{ source: 'enqueue', cacheRefreshed: true }]);
  expect(
    await heard(() => {
      emitDataChanged({ source: 'enqueue', cacheRefreshed: true });
      emitDataChanged({ source: 'enqueue', cacheRefreshed: true });
    })
  ).toEqual([{ source: 'enqueue', cacheRefreshed: true }]);
});

test('a plain change of the same source in the same macrotask takes the mark away, whichever came first: the cache still refreshes for the other writer', async () => {
  expect(
    await heard(() => {
      emitDataChanged({ source: 'enqueue', cacheRefreshed: true });
      emitDataChanged({ source: 'enqueue' });
    })
  ).toEqual([{ source: 'enqueue' }]);
  expect(
    await heard(() => {
      emitDataChanged({ source: 'enqueue' });
      emitDataChanged({ source: 'enqueue', cacheRefreshed: true });
    })
  ).toEqual([{ source: 'enqueue' }]);
  // Another source is its own event.
  expect(
    await heard(() => {
      emitDataChanged({ source: 'enqueue', cacheRefreshed: true });
      emitDataChanged({ source: 'finalize' });
    })
  ).toEqual([{ source: 'enqueue', cacheRefreshed: true }, { source: 'finalize' }]);
});

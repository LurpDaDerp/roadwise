/** @jest-environment node */
import { emitDataChanged, onDataChanged, type DataChange } from '@/data/events';

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

test('a change is delivered on a macrotask, never inside the emitting call', async () => {
  const seen: DataChange[] = [];
  const off = onDataChanged((e) => seen.push(e));
  try {
    emitDataChanged({ source: 'enqueue' });
    // Inline delivery would reach a listener inside the transaction that enqueued.
    expect(seen).toEqual([]);
    await tick();
    expect(seen).toEqual([{ source: 'enqueue' }]);
  } finally {
    off();
  }
});

test('a burst of the same bare source is delivered once; different sources each once', async () => {
  const seen: string[] = [];
  const off = onDataChanged((e) => seen.push(e.source));
  try {
    for (let i = 0; i < 10; i += 1) emitDataChanged({ source: 'enqueue' });
    emitDataChanged({ source: 'hydrate' });
    emitDataChanged({ source: 'finalize' });
    emitDataChanged({ source: 'hydrate' });
    await tick();
    expect(seen).toEqual(['enqueue', 'hydrate', 'finalize']);
  } finally {
    off();
  }
});

test('two sync changes in one macrotask are both delivered, each with its own counts', async () => {
  const seen: DataChange[] = [];
  const off = onDataChanged((e) => seen.push(e));
  try {
    emitDataChanged({ source: 'sync', result: { done: 1, failed: 0, deferred: 0 } });
    emitDataChanged({ source: 'sync', result: { done: 0, failed: 2, deferred: 1 } });
    await tick();
    expect(seen).toEqual([
      { source: 'sync', result: { done: 1, failed: 0, deferred: 0 } },
      { source: 'sync', result: { done: 0, failed: 2, deferred: 1 } },
    ]);
  } finally {
    off();
  }
});

test('a listener that throws is reported and the others still hear the change', async () => {
  const errors: unknown[] = [];
  const seen: string[] = [];
  const first = onDataChanged(() => {
    throw new Error('boom');
  });
  const second = onDataChanged((e) => seen.push(e.source));
  try {
    emitDataChanged({ source: 'sync', result: { done: 1, failed: 0, deferred: 0 } }, (error) =>
      errors.push(error)
    );
    await tick();
    expect(seen).toEqual(['sync']);
    expect(errors).toHaveLength(1);
  } finally {
    first();
    second();
  }
});

test('nothing is scheduled while nobody listens, and an unsubscribed listener hears nothing', async () => {
  const spy = jest.spyOn(globalThis, 'setTimeout');
  try {
    emitDataChanged({ source: 'enqueue' });
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }

  const seen: string[] = [];
  const off = onDataChanged((e) => seen.push(e.source));
  off();
  off();
  emitDataChanged({ source: 'enqueue' });
  await tick();
  expect(seen).toEqual([]);
});

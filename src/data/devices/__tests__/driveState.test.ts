import type { EngineStatus } from '@/core/engine/engine.types';
import type { DriveState } from '@/drive/host';

import { createFakeSupabase } from '../__fixtures__/fakeSupabase';
import { createDriveStateReporter } from '../driveState';

const state = (status: EngineStatus) => ({ status }) as DriveState;

function setup() {
  const fake = createFakeSupabase();
  const onError = jest.fn();
  const reporter = createDriveStateReporter({
    supabase: fake.client,
    userId: 'user-a',
    deviceId: 'install-1',
    onError,
  });
  const feed = async (...statuses: EngineStatus[]) => {
    for (const s of statuses) reporter.onDriveState(state(s));
    await reporter.settled();
  };
  const writes = () => fake.to('devices').map((c) => (c.values as { drive_state: string }).drive_state);
  return { fake, reporter, feed, writes, onError };
}

describe('drive-state reporter', () => {
  it('a candidate that is discarded writes nothing', async () => {
    const { feed, writes } = setup();
    await feed('armed', 'candidate', 'candidate', 'armed', 'off', 'armed');
    expect(writes()).toEqual([]);
  });

  it('recording writes once however many ticks follow', async () => {
    const { feed, writes, fake } = setup();
    await feed('armed', 'candidate', 'recording', 'recording', 'recording', 'ending', 'recording');
    expect(writes()).toEqual(['recording']);
    const [call] = fake.to('devices');
    expect(call?.op).toBe('update');
    // only the state: the server stamps drive_state_at itself (T2 M-1)
    expect(call?.values).toEqual({ drive_state: 'recording' });
    expect(call?.filters).toEqual([
      ['user_id', 'user-a'],
      ['id', 'install-1'],
    ]);
  });

  it.each<EngineStatus>(['armed', 'off', 'finalizing'])('leaving the drive for %s writes one idle', async (to) => {
    const { feed, writes } = setup();
    await feed('candidate', 'recording', 'ending', to, 'armed', 'off');
    expect(writes()).toEqual(['recording', 'idle']);
  });

  it('ending alone is still the drive: nothing is written', async () => {
    const { feed, writes } = setup();
    await feed('recording', 'ending');
    expect(writes()).toEqual(['recording']);
  });

  it('a second drive writes its own pair', async () => {
    const { feed, writes } = setup();
    await feed('recording', 'finalizing', 'armed', 'candidate', 'recording', 'finalizing', 'armed');
    expect(writes()).toEqual(['recording', 'idle', 'recording', 'idle']);
  });

  it('a failed idle is retried by retryPending (the next foreground), once', async () => {
    const { feed, writes, fake, reporter, onError } = setup();
    await feed('recording');
    fake.respond = () => ({ data: null, error: { message: 'offline' } });
    await feed('armed');
    expect(onError).toHaveBeenCalledTimes(1);
    fake.respond = (c) => ({ data: c.columns ? [{ id: 'install-1' }] : null, error: null });
    await reporter.retryPending();
    expect(writes()).toEqual(['recording', 'idle', 'idle']);
    await reporter.retryPending();
    expect(writes()).toHaveLength(3);
  });

  it('a write that matched no row counts as failed (no device row yet)', async () => {
    const { feed, fake, reporter, writes } = setup();
    await feed('recording');
    fake.respond = () => ({ data: [], error: null });
    await feed('armed');
    fake.respond = () => ({ data: [{ id: 'install-1' }], error: null });
    await reporter.retryPending();
    expect(writes()).toEqual(['recording', 'idle', 'idle']);
  });

  it('a pending idle is dropped once a new drive is recording', async () => {
    const { feed, fake, reporter, writes } = setup();
    await feed('recording');
    fake.respond = () => ({ data: null, error: { message: 'offline' } });
    await feed('armed');
    fake.respond = () => ({ data: [{ id: 'install-1' }], error: null });
    await feed('recording');
    await reporter.retryPending();
    expect(writes()).toEqual(['recording', 'idle', 'recording']);
  });

  it('nothing to retry: retryPending makes no request', async () => {
    const { reporter, fake } = setup();
    await reporter.retryPending();
    expect(fake.calls).toHaveLength(0);
  });

  it('writes land in order even when the first is slow', async () => {
    const { fake, reporter } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    fake.respond = async (c) => {
      const s = (c.values as { drive_state: string }).drive_state;
      if (s === 'recording') await gate;
      order.push(s);
      return { data: [{ id: 'install-1' }], error: null };
    };
    reporter.onDriveState(state('recording'));
    reporter.onDriveState(state('armed'));
    release();
    await reporter.settled();
    expect(order).toEqual(['recording', 'idle']);
  });
});

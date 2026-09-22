import { createSettingsRepo } from '@/data/db';
import { createTestDb } from '@/data/queries/__fixtures__/harness';

import { getInstallId, INSTALL_ID_KEY, readInstallId } from '../installId';

describe('install id', () => {
  it('is made once and then read back', async () => {
    const settings = createSettingsRepo(await createTestDb());
    const newId = jest.fn(() => 'aaaaaaaa-1111-4222-8333-444444444444');
    expect(await readInstallId(settings)).toBeNull();
    const first = await getInstallId(settings, newId);
    expect(first).toBe('aaaaaaaa-1111-4222-8333-444444444444');
    expect(await getInstallId(settings, () => 'other-id-000000')).toBe(first);
    expect(await settings.get(INSTALL_ID_KEY)).toBe(first);
    expect(newId).toHaveBeenCalledTimes(1);
  });

  it('is new after a wipe (the settings table emptied)', async () => {
    const db = await createTestDb();
    const settings = createSettingsRepo(db);
    await getInstallId(settings, () => 'first-install-0001');
    await db.execute('DELETE FROM settings');
    expect(await getInstallId(settings, () => 'second-install-0002')).toBe('second-install-0002');
  });

  it('two concurrent first calls agree on one id', async () => {
    const settings = createSettingsRepo(await createTestDb());
    let n = 0;
    const newId = () => `concurrent-id-${++n}000000`;
    const [a, b] = await Promise.all([getInstallId(settings, newId), getInstallId(settings, newId)]);
    expect(a).toBe(b);
  });

  it('a malformed stored value is replaced, never sent', async () => {
    const settings = createSettingsRepo(await createTestDb());
    await settings.set(INSTALL_ID_KEY, 'x'.repeat(200));
    expect(await readInstallId(settings)).toBeNull();
    expect(await getInstallId(settings, () => 'replacement-0001')).toBe('replacement-0001');
  });
});

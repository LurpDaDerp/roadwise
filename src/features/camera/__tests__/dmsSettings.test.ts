// The DMS settings (plan §10) and the decision turning DMS on leads to.
import { DMS_CALIBRATED_KEY, DMS_ENABLED_KEY, enableStep, readDmsPrefs, writeDmsCalibrated, writeDmsEnabled } from '../dmsSettings';

function memorySettings(initial: Record<string, unknown> = {}) {
  const m = new Map<string, unknown>(Object.entries(initial));
  return {
    map: m,
    set: async (k: string, v: unknown) => void m.set(k, v),
    getMany: async (keys: readonly string[]) => Object.fromEntries(keys.filter((k) => m.has(k)).map((k) => [k, m.get(k)])),
  };
}

test('the keys are the plan’s, and off / uncalibrated by default', async () => {
  expect(DMS_ENABLED_KEY).toBe('dms.enabled');
  expect(DMS_CALIBRATED_KEY).toBe('dms.calibratedAt');
  await expect(readDmsPrefs(memorySettings())).resolves.toEqual({ enabled: false, calibratedAt: null });
  await expect(readDmsPrefs(memorySettings({ 'dms.enabled': 'yes', 'dms.calibratedAt': 'then' }))).resolves.toEqual({ enabled: false, calibratedAt: null });
  await expect(readDmsPrefs(memorySettings({ 'dms.enabled': true, 'dms.calibratedAt': 1_760_000_000_000 }))).resolves.toEqual({ enabled: true, calibratedAt: 1_760_000_000_000 });
});

test('enableStep: the permission first, then the setup if never calibrated, then on', () => {
  expect(enableStep('denied', false)).toBe('permission_denied');
  expect(enableStep('undetermined', true)).toBe('permission_denied');
  expect(enableStep('unavailable', true)).toBe('unavailable');
  expect(enableStep('granted', false)).toBe('setup');
  expect(enableStep('granted', true)).toBe('enabled');
});

test('writes: enabled on/off; a successful setup stamps the date and turns DMS on', async () => {
  const s = memorySettings();
  await writeDmsEnabled(s, true);
  expect(s.map.get('dms.enabled')).toBe(true);
  await writeDmsEnabled(s, false);
  expect(s.map.get('dms.enabled')).toBe(false);
  await writeDmsCalibrated(s, 1_760_000_000_000);
  expect(s.map.get('dms.calibratedAt')).toBe(1_760_000_000_000);
  expect(s.map.get('dms.enabled')).toBe(true);
});

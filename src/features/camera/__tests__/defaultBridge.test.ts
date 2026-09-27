// Review LB-1: expo-battery's level is a fraction (0–1); the capture policy reads a percent.
import { batteryWatch, toPercent } from '../defaultBridge';

const mockBattery = { level: 0.8, state: 1 };
jest.mock('expo-battery', () => ({
  BatteryState: { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3 },
  getPowerStateAsync: jest.fn(async () => ({ batteryLevel: mockBattery.level, batteryState: mockBattery.state, lowPowerMode: false })),
  addBatteryLevelListener: jest.fn(),
  addBatteryStateListener: jest.fn(),
}));
jest.mock('@/features/settings/alerts/voicePref', () => ({ voicePrefEnabled: () => true }));

test('0.8 unplugged reads 80 %, not charging; 0.15 reads 15; unknown (-1) reads null', async () => {
  const w = batteryWatch(() => {});
  await w.start();
  expect(w.read()).toEqual({ level: 80, charging: false });
  expect(toPercent(0.15)).toBe(15);
  expect(toPercent(-1)).toBeNull();
  expect(toPercent(1)).toBe(100);
});

test('charging is read from the state', async () => {
  mockBattery.state = 2;
  const w = batteryWatch(() => {});
  await w.start();
  expect(w.read().charging).toBe(true);
  mockBattery.state = 1;
});

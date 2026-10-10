import { ALERT_GLOW_MS, decisionFor } from '@/core/alerts/policy';

const at = 1_700_000_000_000;

test('speeding is the soft chime (level 1), no voice, one light pulse', () => {
  expect(decisionFor({ id: 'e1', type: 'speeding', tier: 'moderate', at }, { voiceEnabled: true })).toEqual({
    id: 'e1',
    level: 1,
    kind: 'speeding',
    ts: at,
    intensity: 1,
  });
});

test('harsh driving is the warning tone with a short voice line only when voice is on; severe vibrates harder', () => {
  const minor = decisionFor({ id: 'e2', type: 'hard_brake', tier: 'minor', at }, { voiceEnabled: true });
  expect(minor).toMatchObject({ level: 2, kind: 'hard_brake', voice: 'Hard brake', intensity: 2 });
  const severe = decisionFor({ id: 'e2', type: 'hard_brake', tier: 'severe', at }, { voiceEnabled: false });
  expect(severe.voice).toBeUndefined();
  expect(severe.intensity).toBe(3);
});

test('a phone pickup is urgent (level 3), spoken only when voice is on', () => {
  expect(decisionFor({ id: 'e3', type: 'phone_pickup', tier: 'severe', at }, { voiceEnabled: true })).toMatchObject({ level: 3, voice: 'Phone down', intensity: 4 });
  expect(decisionFor({ id: 'e3', type: 'phone_pickup', tier: 'severe', at }, { voiceEnabled: false }).voice).toBeUndefined();
  expect(ALERT_GLOW_MS).toBe(1500);
});

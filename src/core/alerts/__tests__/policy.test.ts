import { ALERT_GLOW_MS, ALERT_LEVEL, ALERT_VOICE, decisionFor } from '@/core/alerts/policy';

const at = 1_700_000_000_000;

test('speeding is the soft chime (level 1), no voice, one light pulse, holding the session while the car stays over', () => {
  expect(decisionFor({ id: 'e1', type: 'speeding', tier: 'moderate', at }, { voiceEnabled: true })).toEqual({
    id: 'e1',
    level: 1,
    kind: 'speeding',
    ts: at,
    intensity: 1,
    holdSession: true,
  });
});

test('a speeding repeat is the same plain chime: no other tone, no cue', () => {
  expect(decisionFor({ id: 'e1', type: 'speeding', tier: 'minor', at, repeat: true }, { voiceEnabled: true })).toEqual({
    id: 'e1',
    level: 1,
    kind: 'speeding',
    ts: at,
    intensity: 1,
    holdSession: true,
  });
});

test('harsh driving is the warning tone with a short voice line only when voice is on; severe vibrates harder; only speeding holds the session', () => {
  const minor = decisionFor({ id: 'e2', type: 'hard_brake', tier: 'minor', at }, { voiceEnabled: true });
  expect(minor).toEqual({ id: 'e2', level: 2, kind: 'hard_brake', ts: at, voice: 'Hard brake', intensity: 2 });
  const severe = decisionFor({ id: 'e2', type: 'hard_brake', tier: 'severe', at }, { voiceEnabled: false });
  expect(severe.voice).toBeUndefined();
  expect(severe.intensity).toBe(3);
  expect(severe.holdSession).toBeUndefined();
  expect(ALERT_GLOW_MS).toBe(1500);
});

test('the maps cover the six event types and nothing else (no phone use)', () => {
  expect(Object.keys(ALERT_LEVEL).sort()).toEqual(['drowsy', 'eyes_off', 'hard_accel', 'hard_brake', 'hard_corner', 'speeding']);
  expect(Object.keys(ALERT_VOICE).sort()).toEqual(Object.keys(ALERT_LEVEL).sort());
});

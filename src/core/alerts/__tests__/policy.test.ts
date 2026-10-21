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

test('the maps cover the seven event types and nothing else', () => {
  expect(Object.keys(ALERT_LEVEL).sort()).toEqual(['drowsy', 'eyes_off', 'hard_accel', 'hard_brake', 'hard_corner', 'phone_pickup', 'speeding']);
  expect(Object.keys(ALERT_VOICE).sort()).toEqual(Object.keys(ALERT_LEVEL).sort());
});

test('a phone pickup is the urgent tone (level 3) with "Phone down" when voice is on and the longest haptic; no points cue, no held session', () => {
  expect(decisionFor({ id: 'p1', type: 'phone_pickup', tier: 'moderate', at }, { voiceEnabled: true })).toEqual({
    id: 'p1',
    level: 3,
    kind: 'phone_pickup',
    ts: at,
    voice: 'Phone down',
    intensity: 4,
  });
  expect(decisionFor({ id: 'p1', type: 'phone_pickup', tier: 'severe', at }, { voiceEnabled: false })).toEqual({ id: 'p1', level: 3, kind: 'phone_pickup', ts: at, intensity: 4 });
});

test('a phone repeat (still in hand) is the tone and haptic only, never the voice line', () => {
  expect(decisionFor({ id: 'p1', type: 'phone_pickup', tier: 'severe', at, repeat: true }, { voiceEnabled: true })).toEqual({
    id: 'p1',
    level: 3,
    kind: 'phone_pickup',
    ts: at,
    intensity: 4,
  });
});

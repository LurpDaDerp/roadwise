// The two DashPal event types in the phone's exhaustive maps: never raised by the phone's engine,
// but every map names their level, voice line, HUD words and labels.
import { DASHCAM_EVENT_TYPES } from '@scoring';

import { ALERT_LEVEL, ALERT_VOICE, decisionFor } from '@/core/alerts/policy';
import { hudCopy } from '@/features/drive/hudCopy';
import { EVENT_ICON, EVENT_LABEL, eventName } from '@/features/drives/format';

const at = 1_700_000_000_000;

test('drowsy is level 3 "Take a break"; eyes off is level 2 "Eyes up"', () => {
  expect([ALERT_LEVEL.drowsy, ALERT_VOICE.drowsy]).toEqual([3, 'Take a break']);
  expect([ALERT_LEVEL.eyes_off, ALERT_VOICE.eyes_off]).toEqual([2, 'Eyes up']);
  expect(decisionFor({ id: 'd1', type: 'drowsy', tier: 'severe', at }, { voiceEnabled: true })).toMatchObject({ level: 3, voice: 'Take a break', intensity: 4 });
  expect(decisionFor({ id: 'd2', type: 'eyes_off', tier: 'severe', at }, { voiceEnabled: false })).toMatchObject({ level: 2, intensity: 3 });
});

test('the HUD chip words', () => {
  expect(hudCopy.alert.drowsy).toBe('Take a break');
  expect(hudCopy.alert.eyes_off).toBe('Eyes up');
});

test('the drive screens label both types and mark them DashPal', () => {
  expect(DASHCAM_EVENT_TYPES.map((t) => [EVENT_LABEL[t], EVENT_ICON[t]])).toEqual([
    ['Eyes off road', 'eye-off-outline'],
    ['Drowsy', 'moon-outline'],
  ]);
  expect(eventName('eyes_off', 'severe')).toBe('Eyes off road · DashPal');
  expect(eventName('drowsy', 'severe')).toBe('Drowsy · DashPal');
  expect(eventName('hard_brake', 'severe')).toBe('Hard brake · Severe');
  expect(eventName('phone_pickup', 'severe')).toBe('Phone pickup');
});

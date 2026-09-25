// Task C3 (design rev3 §2.5, rev4 §2.5): the HUD's `monitoring` literal, one per status branch: what each rule
// family is doing and why. The HUD copy (U-5) maps the reason to its words (M4, T16).
import { monitoringOf, type MonitoringInput } from '../status';

const moving: MonitoringInput['engine'] = { speedState: 'moving_known', distraction: 'full' };

describe('C3: monitoringOf', () => {
  test('active and moving: the engine says what distraction does; sleep rules full', () => {
    expect(monitoringOf({ camera: 'active', reason: null, engine: moving })).toEqual({ distraction: 'full', drowsiness: 'full', reason: null });
    expect(monitoringOf({ camera: 'active', reason: null, engine: { speedState: 'moving_known', distraction: 'widened' } })).toEqual({ distraction: 'widened', drowsiness: 'full', reason: null });
  });
  test('SLEEP_WATCH at a stop: distraction off, sleep rules full, reason stopped', () => {
    expect(monitoringOf({ camera: 'active', reason: null, engine: { speedState: 'stopped', distraction: 'off' } })).toEqual({ distraction: 'off', drowsiness: 'full', reason: 'stopped' });
  });
  test('ambiguous speed (U-7): distraction off, reason speed_unknown', () => {
    expect(monitoringOf({ camera: 'active', reason: null, engine: { speedState: 'ambiguous', distraction: 'off' } })).toEqual({ distraction: 'off', drowsiness: 'full', reason: 'speed_unknown' });
  });
  test('heat: off / off; dark and absent: off / limited', () => {
    expect(monitoringOf({ camera: 'paused', reason: 'thermal', engine: moving })).toEqual({ distraction: 'off', drowsiness: 'off', reason: 'heat' });
    expect(monitoringOf({ camera: 'paused', reason: 'low_light', engine: moving })).toEqual({ distraction: 'off', drowsiness: 'limited', reason: 'dark' });
    expect(monitoringOf({ camera: 'paused', reason: 'absent', engine: moving })).toEqual({ distraction: 'off', drowsiness: 'limited', reason: 'absent' });
  });
  test('the eyes not seen: sleep rules limited (reason eyes); a face lost in the dark is dark', () => {
    expect(monitoringOf({ camera: 'limited', reason: 'eyes_not_visible', engine: moving })).toEqual({ distraction: 'full', drowsiness: 'limited', reason: 'eyes' });
    expect(monitoringOf({ camera: 'limited', reason: 'face_lost', engine: moving })).toEqual({ distraction: 'off', drowsiness: 'limited', reason: 'eyes' });
    expect(monitoringOf({ camera: 'limited', reason: 'low_light', engine: moving })).toEqual({ distraction: 'off', drowsiness: 'limited', reason: 'dark' });
  });
  test('off, starting and faults: off / off; the app in the background is said', () => {
    expect(monitoringOf({ camera: 'off', reason: 'app_inactive', engine: null })).toEqual({ distraction: 'off', drowsiness: 'off', reason: 'app_inactive' });
    expect(monitoringOf({ camera: 'off', reason: 'no_drive', engine: null })).toEqual({ distraction: 'off', drowsiness: 'off', reason: null });
    expect(monitoringOf({ camera: 'starting', reason: null, engine: moving })).toEqual({ distraction: 'off', drowsiness: 'off', reason: null });
    expect(monitoringOf({ camera: 'limited', reason: 'error', engine: moving })).toEqual({ distraction: 'off', drowsiness: 'off', reason: null });
    expect(monitoringOf({ camera: 'paused', reason: null, engine: moving })).toEqual({ distraction: 'off', drowsiness: 'off', reason: null });
  });
  test('active with no engine view yet: off / off', () => {
    expect(monitoringOf({ camera: 'active', reason: null, engine: null })).toEqual({ distraction: 'off', drowsiness: 'off', reason: null });
  });
});

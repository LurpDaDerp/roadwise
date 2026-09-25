// Task C3 (design rev3 §2.5, rev4 §2.5): the HUD's `monitoring` literal, one per status branch: what each rule
// family is doing and why. The HUD copy (U-5) maps the reason to its words (M4, T16).
// C3 round 1 (review-C3 m3, m4): a lost face says `face`, a camera fault says `camera`, and each family has its
// own cause (`why`); the headline `reason` is the most useful one (a stop before a lost face).
import { monitoringOf, type DmsMonitoring, type MonitoringInput, type MonitoringReason } from '../status';

const moving: MonitoringInput['engine'] = { speedState: 'moving_known', distraction: 'full' };
const stopped: MonitoringInput['engine'] = { speedState: 'stopped', distraction: 'off' };
const M = (distraction: DmsMonitoring['distraction'], drowsiness: DmsMonitoring['drowsiness'], reason: MonitoringReason, whyD: MonitoringReason = reason, whyS: MonitoringReason = reason): DmsMonitoring => ({
  distraction,
  drowsiness,
  reason,
  why: { distraction: whyD, drowsiness: whyS },
});

describe('C3: monitoringOf', () => {
  test('active and moving: the engine says what distraction does; sleep rules full', () => {
    expect(monitoringOf({ camera: 'active', reason: null, engine: moving })).toEqual(M('full', 'full', null));
    expect(monitoringOf({ camera: 'active', reason: null, engine: { speedState: 'moving_known', distraction: 'widened' } })).toEqual(M('widened', 'full', null));
  });
  test('SLEEP_WATCH at a stop: distraction off, sleep rules full, reason stopped', () => {
    expect(monitoringOf({ camera: 'active', reason: null, engine: stopped })).toEqual(M('off', 'full', 'stopped', 'stopped', null));
  });
  test('ambiguous speed (U-7): distraction off, reason speed_unknown', () => {
    expect(monitoringOf({ camera: 'active', reason: null, engine: { speedState: 'ambiguous', distraction: 'off' } })).toEqual(M('off', 'full', 'speed_unknown', 'speed_unknown', null));
  });
  test('heat: off / off; dark and absent: off / limited', () => {
    expect(monitoringOf({ camera: 'paused', reason: 'thermal', engine: moving })).toEqual(M('off', 'off', 'heat'));
    expect(monitoringOf({ camera: 'paused', reason: 'low_light', engine: moving })).toEqual(M('off', 'limited', 'dark'));
    expect(monitoringOf({ camera: 'paused', reason: 'absent', engine: moving })).toEqual(M('off', 'limited', 'absent'));
  });
  test('the eyes not seen: sleep rules limited (eyes); the whole face lost says face (C3 round 1, m3); the dark is dark', () => {
    expect(monitoringOf({ camera: 'limited', reason: 'eyes_not_visible', engine: moving })).toEqual(M('full', 'limited', 'eyes', null, 'eyes'));
    expect(monitoringOf({ camera: 'limited', reason: 'face_lost', engine: moving })).toEqual(M('off', 'limited', 'face'));
    expect(monitoringOf({ camera: 'limited', reason: 'low_light', engine: moving })).toEqual(M('off', 'limited', 'dark'));
  });
  test('C3 round 1 (m4): at a stop with the face lost, the headline is stopped: distraction for the stop, sleep rules for the face', () => {
    expect(monitoringOf({ camera: 'limited', reason: 'face_lost', engine: stopped })).toEqual(M('off', 'limited', 'stopped', 'stopped', 'face'));
    expect(monitoringOf({ camera: 'limited', reason: 'eyes_not_visible', engine: stopped })).toEqual(M('off', 'limited', 'stopped', 'stopped', 'eyes'));
  });
  test('C3 round 1 (m3): a camera interruption or fault always has a cause', () => {
    expect(monitoringOf({ camera: 'limited', reason: 'error', engine: moving })).toEqual(M('off', 'off', 'camera'));
    expect(monitoringOf({ camera: 'limited', reason: 'interrupted', engine: moving })).toEqual(M('off', 'off', 'camera'));
    expect(monitoringOf({ camera: 'off', reason: 'error', engine: null })).toEqual(M('off', 'off', 'camera'));
  });
  test('off and starting: off / off; the app in the background is said', () => {
    expect(monitoringOf({ camera: 'off', reason: 'app_inactive', engine: null })).toEqual(M('off', 'off', 'app_inactive'));
    expect(monitoringOf({ camera: 'off', reason: 'no_drive', engine: null })).toEqual(M('off', 'off', null));
    expect(monitoringOf({ camera: 'starting', reason: null, engine: moving })).toEqual(M('off', 'off', null));
    expect(monitoringOf({ camera: 'paused', reason: null, engine: moving })).toEqual(M('off', 'off', null));
  });
  test('active with no engine view yet: off / off', () => {
    expect(monitoringOf({ camera: 'active', reason: null, engine: null })).toEqual(M('off', 'off', null));
  });
  test('C6 round 1 (C6-2): no EAR reference yet (the population prior): drowsiness limited, learning_eyes; a stop still heads', () => {
    expect(monitoringOf({ camera: 'active', reason: null, engine: { ...moving, priorMode: true } })).toEqual(M('full', 'limited', 'learning_eyes', null, 'learning_eyes'));
    expect(monitoringOf({ camera: 'active', reason: null, engine: { ...stopped, priorMode: true } })).toEqual(M('off', 'limited', 'stopped', 'stopped', 'learning_eyes'));
    expect(monitoringOf({ camera: 'active', reason: null, engine: { ...moving, priorMode: false } })).toEqual(M('full', 'full', null));
  });
  test('Task C7 (H5): the eye baseline degraded: drowsiness limited, eyes; health widening reads as widened / recalibrating', () => {
    expect(monitoringOf({ camera: 'active', reason: null, engine: { ...moving, eyesDegraded: true } })).toEqual(M('full', 'limited', 'eyes', null, 'eyes'));
    expect(monitoringOf({ camera: 'active', reason: null, engine: { speedState: 'moving_known', distraction: 'widened', calReason: 'recalibrating' } })).toEqual(M('widened', 'full', 'recalibrating', 'recalibrating', null));
  });
});

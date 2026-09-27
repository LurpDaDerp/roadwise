import { render, screen } from '@testing-library/react-native';

import type { DmsHudStatus } from '@/core/dms';

import { CameraChip } from '../CameraChip';
import { cameraCopy, chipLabel, chipTone } from '../copy';

const S = (over: Partial<DmsHudStatus> = {}, reason: DmsHudStatus['monitoring']['reason'] = null): DmsHudStatus => ({
  camera: 'active',
  reason: null,
  calibration: 'calibrated',
  fatigueLevel: 'alert' as DmsHudStatus['fatigueLevel'],
  dimAdvised: false,
  monitoring: { distraction: 'full', drowsiness: 'full', reason, why: { distraction: reason, drowsiness: reason } },
  ...over,
});

const c = cameraCopy.chip;

test.each([
  ['watching', S(), c.watching, 'on'],
  ['stopped', S({}, 'stopped'), c.sleepOnly, 'on'],
  ['starting', S({ camera: 'starting' }), c.starting, 'limited'],
  ['heat pause', S({ camera: 'paused', reason: 'thermal' }), c.heat, 'limited'],
  ['dark pause', S({ camera: 'paused', reason: 'low_light' }), c.dark, 'limited'],
  ['empty seat', S({ camera: 'paused', reason: 'absent' }), c.absent, 'limited'],
  ['face lost', S({ camera: 'limited', reason: 'face_lost' }, 'face'), c.face, 'limited'],
  ['eyes', S({ camera: 'limited', reason: 'eyes_not_visible' }), c.eyes, 'limited'],
  ['learning', S({}, 'learning_eyes'), c.learning, 'limited'],
  ['recalibrating', S({}, 'recalibrating'), c.recalibrating, 'limited'],
  ['permission', S({ camera: 'off', reason: 'permission' }), c.permission, 'limited'],
  ['busy', S({ camera: 'off', reason: 'busy' }), c.busy, 'limited'],
  ['error', S({ camera: 'off', reason: 'error' }), c.error, 'limited'],
] as const)('%s', (_, status, label, tone) => {
  expect(chipLabel(status)).toBe(label);
  expect(chipTone(status)).toBe(tone);
});

test.each(['not_opted_in', 'flag_off', 'age', 'no_drive', 'mode', 'role', 'app_inactive'] as const)(
  'off for %s: no chip (nothing for the driver to act on)',
  async (reason) => {
    expect(chipLabel(S({ camera: 'off', reason }))).toBeNull();
    await render(<CameraChip ink="#fff" inkMuted="#999" status={S({ camera: 'off', reason })} />);
    expect(screen.queryByTestId('hud-camera-chip')).toBeNull();
  }
);

test('the chip draws its words and is labelled for a screen reader', async () => {
  await render(<CameraChip ink="#fff" inkMuted="#999" status={S({}, 'stopped')} />);
  expect(screen.getByTestId('hud-camera-chip')).toHaveProp('accessibilityLabel', c.sleepOnly);
  expect(screen.getByText(c.sleepOnly)).toBeOnTheScreen();
});

test('no camera runtime: nothing', async () => {
  await render(<CameraChip ink="#fff" inkMuted="#999" />);
  expect(screen.queryByTestId('hud-camera-chip')).toBeNull();
});

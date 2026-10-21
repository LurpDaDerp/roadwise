/** The permission words: exact lines, and the length limits (Home ≤ 60, Settings details ≤ 100). */
import { IDLE_END_S } from '@scoring';

import { DETAIL_MAX, HOME_LINE_MAX, homeLine, permissionName, permissionsCopy, requestLabel, rowDetail, rowTitle, statusWord, type CopyCtx } from '../copy';
import { PERMISSION_IDS, type MissingReason, type MissingState, type PermState, type SettingsTarget } from '../registry';

const IOS: CopyCtx = { platform: 'ios', androidApi: null };
const ANDROID: CopyCtx = { platform: 'android', androidApi: 34 };
const ANDROID_11: CopyCtx = { platform: 'android', androidApi: 30 };
const CTXS = [IOS, ANDROID, ANDROID_11];

const m = (reason: MissingReason, canAsk = false, target: SettingsTarget = 'app'): MissingState => ({ kind: 'missing', reason, canAsk, target });
const ALL_STATES: PermState[] = [{ kind: 'granted' }, { kind: 'idle' }, { kind: 'unknown' }, m('notYet', true), m('denied'), m('servicesOff', true, 'locationServices')];

test('every Home line fits in 60 characters, every Settings detail in 100, on every platform', () => {
  for (const c of CTXS) {
    for (const id of PERMISSION_IDS) {
      for (const s of ALL_STATES) {
        if (s.kind === 'missing') expect(homeLine(id, s, c).length).toBeLessThanOrEqual(HOME_LINE_MAX);
        expect(rowDetail(id, s, c).length).toBeLessThanOrEqual(DETAIL_MAX);
      }
    }
  }
});

test('Home lines', () => {
  expect(homeLine('location', m('denied'), IOS)).toBe("Location is off. Drives can't record.");
  expect(homeLine('location', m('notYet', true), ANDROID)).toBe('Allow Location so drives can record.');
  expect(homeLine('location', m('servicesOff', true, 'locationServices'), ANDROID)).toBe("Location Services are off. Drives can't record.");
  expect(homeLine('location', m('servicesOff'), IOS)).toBe('Location Services are off. Turn on in Privacy & Security.');
  expect(homeLine('precise', m('denied'), IOS)).toBe("Precise Location is off. Drives can't record.");
  expect(homeLine('locationAlways', m('notYet', true), IOS)).toBe('Set Location to Always so drives start themselves.');
  expect(homeLine('backgroundRefresh', m('denied'), IOS)).toBe('Turn on Background App Refresh to catch every drive.');
  expect(homeLine('motion', m('denied'), IOS)).toBe('Motion & Fitness is off. Drives won’t start themselves.');
  expect(homeLine('motion', m('notYet', true), IOS)).toBe('Allow Motion & Fitness so RoadWise can spot drives.');
  expect(homeLine('motion', m('denied', true), ANDROID)).toBe("Physical activity is off. Walking away won't end a drive.");
  expect(homeLine('motion', m('notYet', true), ANDROID)).toBe('Allow Physical activity so walking away ends a drive.');
  expect(homeLine('notifications', m('denied'), ANDROID)).toBe('Notifications are off. You’ll miss your drive recaps.');
  expect(homeLine('notifications', m('notYet', true), IOS)).toBe('Allow Notifications to get your drive recaps.');
  expect(homeLine('bluetooth', m('denied'), IOS)).toBe("Bluetooth isn't allowed. DashPal can't connect.");
  expect(homeLine('bluetooth', m('denied'), ANDROID)).toBe("Nearby devices isn't allowed. DashPal can't connect.");
});

test('the motion lines say what motion access does on each phone', () => {
  expect(rowDetail('motion', { kind: 'granted' }, IOS)).toBe('RoadWise can tell driving from walking, so drives start and end on time.');
  expect(rowDetail('motion', m('notYet', true), IOS)).toBe('Without it, drives won’t start on their own.');
  expect(rowDetail('motion', m('denied'), IOS)).toBe('Drives won’t start on their own. Also check Privacy & Security › Motion & Fitness.');
  expect(rowDetail('motion', { kind: 'granted' }, ANDROID)).toBe('A forgotten drive stops when you walk away.');
  expect(rowDetail('motion', m('denied', true), ANDROID)).toBe(`Without it, a forgotten drive ends after ${IDLE_END_S / 60} min.`);
});

test('the automatic-drive rows and notifications say what they do', () => {
  expect(rowDetail('locationAlways', { kind: 'granted' }, IOS)).toBe('RoadWise can notice your drives and record them with the app closed.');
  expect(rowDetail('locationAlways', m('denied'), IOS)).toBe('Drives won’t start on their own. You can still start them from Home.');
  expect(rowDetail('locationAlways', { kind: 'idle' }, IOS)).toBe('Allow Location first.');
  expect(rowDetail('backgroundRefresh', { kind: 'granted' }, IOS)).toBe('iOS can wake RoadWise when a drive starts.');
  expect(rowDetail('backgroundRefresh', m('denied'), IOS)).toBe('iOS can’t wake RoadWise, so drives won’t start on their own.');
  expect(rowDetail('notifications', { kind: 'granted' }, ANDROID)).toBe('Drive recaps, your weekly recap and friend requests can reach you.');
  expect(rowDetail('notifications', m('denied'), IOS)).toBe('You won’t get drive recaps, your weekly recap or friend requests.');
  expect(requestLabel('locationAlways', m('notYet', true))).toBe('Allow Always');
  expect(requestLabel('backgroundRefresh', m('denied'))).toBe('Open Settings');
});

test('the note under the list follows the phone, and no line mentions a reminder or points', () => {
  expect(permissionsCopy.about.ios).toBe('With Location set to Always, RoadWise notices drives and records them even when it’s closed. Your location is never sold.');
  expect(permissionsCopy.about.android).toBe('A drive uses location only while it records. Start each drive from Home.');
  // Phone pickups need no permission: a note of their own says they are felt, never seen.
  expect(permissionsCopy.phone).toBe('On a drive, RoadWise feels when your phone is picked up, from motion alone. It never sees your screen, apps or messages.');
  for (const c of CTXS) {
    for (const id of PERMISSION_IDS) {
      for (const s of ALL_STATES) {
        const lines = [rowTitle(id, c), rowDetail(id, s, c), ...(s.kind === 'missing' ? [homeLine(id, s, c)] : [])];
        for (const line of lines) expect(line).not.toMatch(/reminder|forgot-to-start|\bpoints?\b|—/i);
      }
    }
  }
});

test('Settings details by state and platform', () => {
  expect(rowDetail('location', m('servicesOff'), IOS)).toBe('Location Services are off. Turn them on in Settings › Privacy & Security › Location Services.');
  expect(rowDetail('location', m('servicesOff', true, 'locationServices'), ANDROID)).toBe("Location Services are off, so drives can't record.");
  expect(rowDetail('precise', m('denied'), IOS)).toBe('Approximate location is too rough to record a drive.');
  expect(rowDetail('precise', { kind: 'unknown' }, IOS)).toBe("RoadWise couldn't check this on this phone.");
  expect(rowDetail('bluetooth', { kind: 'idle' }, IOS)).toBe('Used only with a paired DashPal.');
  expect(rowDetail('bluetooth', { kind: 'idle' }, ANDROID)).toBe('Used only with a paired DashPal.');
  expect(rowDetail('bluetooth', { kind: 'idle' }, ANDROID_11)).toBe('Uses Location on this phone.');
  expect(rowDetail('bluetooth', m('denied'), ANDROID)).toBe("Your DashPal can't connect, so it plays its alerts itself.");
  expect(rowDetail('camera', { kind: 'idle' }, IOS)).toBe('Asked when you scan a QR code.');
  expect(rowDetail('camera', m('denied'), ANDROID)).toBe("QR codes can't be scanned. Add friends by username.");
  expect(rowDetail('camera', { kind: 'granted' }, IOS)).toBe('You can scan friend QR codes.');
});

test('titles and the names the confirmation uses follow the platform', () => {
  expect(rowTitle('motion', IOS)).toBe('Motion & Fitness');
  expect(rowTitle('motion', ANDROID)).toBe('Physical activity');
  expect(rowTitle('bluetooth', IOS)).toBe('Bluetooth');
  expect(rowTitle('bluetooth', ANDROID)).toBe('Nearby devices');
  expect(rowTitle('bluetooth', ANDROID_11)).toBe('Bluetooth');
  expect(rowTitle('locationAlways', IOS)).toBe('Location Always');
  expect(rowTitle('backgroundRefresh', IOS)).toBe('Background App Refresh');
  expect(permissionName('locationAlways', IOS)).toBe('Location Always');
  expect(permissionName('location', IOS)).toBe('Location');
  expect(permissionName('precise', ANDROID)).toBe('Precise Location');
  expect(permissionName('motion', IOS)).toBe('Motion & Fitness');
  expect(permissionName('bluetooth', ANDROID)).toBe('Nearby devices');
  expect(permissionsCopy.home.confirmMessage('Motion & Fitness')).toBe(
    "Home won't remind you about Motion & Fitness again. You can undo this in Profile › Settings › Permissions."
  );
});

test('status words', () => {
  expect(statusWord({ kind: 'granted' })).toBe('on');
  expect(statusWord(m('notYet', true))).toBe('notYet');
  expect(statusWord(m('denied'))).toBe('off');
  expect(statusWord(m('servicesOff'))).toBe('off');
  expect(statusWord({ kind: 'idle' })).toBe('idle');
  expect(statusWord({ kind: 'unknown' })).toBe('unknown');
  expect(permissionsCopy.status).toEqual({ on: 'On', notYet: 'Needs a look', off: 'Off', idle: 'Not in use', unknown: "Can't check" });
});

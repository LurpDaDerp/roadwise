/** The permission words: exact lines, and the length limits (Home ≤ 60, Settings details ≤ 100). */
import { DETAIL_MAX, HOME_LINE_MAX, homeLine, permissionName, permissionsCopy, rowDetail, rowTitle, statusWord, type CopyCtx } from '../copy';
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
        for (const reminderOn of [true, false]) expect(rowDetail(id, s, c, { reminderOn }).length).toBeLessThanOrEqual(DETAIL_MAX);
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
  expect(homeLine('motion', m('denied'), IOS)).toBe("Motion & Fitness is off. Walking away won't end a drive.");
  expect(homeLine('motion', m('denied', true), ANDROID)).toBe("Physical activity is off. Walking away won't end a drive.");
  expect(homeLine('motion', m('notYet', true), IOS)).toBe('Allow Motion & Fitness so walking away ends a drive.');
  expect(homeLine('motion', m('notYet', true), ANDROID)).toBe('Allow Physical activity so walking away ends a drive.');
  expect(homeLine('notifications', m('denied'), ANDROID)).toBe("Notifications are off. You'll miss reminders and results.");
  expect(homeLine('notifications', m('notYet', true), IOS)).toBe('Allow Notifications for reminders and results.');
  expect(homeLine('reminderAccess', m('denied'), IOS)).toBe('The reminder needs Location set to Always.');
  expect(homeLine('reminderAccess', m('denied', false, 'reminderChannel'), ANDROID)).toBe('Drive reminder notifications are off.');
  expect(homeLine('bluetooth', m('denied'), IOS)).toBe("Bluetooth isn't allowed. DashPal can't connect.");
  expect(homeLine('bluetooth', m('denied'), ANDROID)).toBe("Nearby devices isn't allowed. DashPal can't connect.");
});

test('the motion lines say what motion access does (one source per surface)', () => {
  expect(rowDetail('motion', { kind: 'granted' }, IOS)).toBe('A forgotten drive stops when you walk away, and the reminder can spot trips.');
  expect(rowDetail('motion', m('denied', true), ANDROID)).toBe('Without it, a forgotten drive ends after 15 min.');
  expect(rowDetail('motion', m('notYet', true), IOS)).toBe('Without it, a forgotten drive ends after 15 min.');
  expect(rowDetail('motion', m('denied'), IOS)).toBe('Without it, a forgotten drive ends after 15 min. Also check Privacy & Security › Motion & Fitness.');
});

test('Settings details by state and platform', () => {
  expect(rowDetail('location', m('servicesOff'), IOS)).toBe('Location Services are off. Turn them on in Settings › Privacy & Security › Location Services.');
  expect(rowDetail('location', m('servicesOff', true, 'locationServices'), ANDROID)).toBe("Location Services are off, so drives can't record.");
  expect(rowDetail('precise', m('denied'), IOS)).toBe('Approximate location is too rough to record a drive.');
  expect(rowDetail('precise', { kind: 'unknown' }, IOS)).toBe("RoadWise couldn't check this on this phone.");
  expect(rowDetail('reminderAccess', { kind: 'idle' }, IOS, { reminderOn: false })).toBe('Only for the forgot-to-start reminder, which is off.');
  expect(rowDetail('reminderAccess', { kind: 'idle' }, IOS, { reminderOn: true })).toBe('Allow Location first, then set it to Always for the reminder.');
  expect(rowDetail('reminderAccess', m('denied', false, 'reminderChannel'), ANDROID)).toBe("The forgot-to-start reminder can't appear.");
  expect(rowDetail('reminderAccess', { kind: 'idle' }, ANDROID, { reminderOn: true })).toBe('Turn on Notifications first so the reminder can appear.');
  expect(rowDetail('reminderAccess', { kind: 'idle' }, ANDROID, { reminderOn: false })).toBe('Only for the forgot-to-start reminder, which is off.');
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
  expect(rowTitle('reminderAccess', IOS)).toBe('Location Always');
  expect(rowTitle('reminderAccess', ANDROID)).toBe('Drive reminder notifications');
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

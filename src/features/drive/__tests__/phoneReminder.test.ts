import type { DriveHost, DriveState, LastFinalized } from '@/drive/host';
import { DRIVE_HREF, drivingHrefOf } from '@/features/notifications/hrefs';
import {
  cancelPhoneReminders,
  createPhoneReminder,
  PHONE_REMINDER_GAP_S,
  PHONE_REMINDER_KIND,
  phoneReminderCopy,
  phoneReminderIdentifier,
  type PhoneReminderPort,
  type PhoneReminderRequest,
  type PostedReminder,
} from '@/features/drive/phoneReminder';

const T0 = 1_700_000_000_000;
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

function fakePort(granted = true): PhoneReminderPort & { posts: PhoneReminderRequest[]; cancels: string[]; shown: PostedReminder[]; granted: boolean } {
  const port = {
    granted,
    posts: [] as PhoneReminderRequest[],
    cancels: [] as string[],
    shown: [] as PostedReminder[],
    permissionGranted: async () => port.granted,
    post: async (req: PhoneReminderRequest) => {
      port.posts.push(req);
      port.shown = [...port.shown.filter((r) => r.identifier !== req.identifier), { identifier: req.identifier, clientTripId: req.clientTripId }];
    },
    posted: async () => port.shown,
    cancel: async (identifier: string) => {
      port.cancels.push(identifier);
      port.shown = port.shown.filter((r) => r.identifier !== identifier);
    },
  };
  return port;
}

type Snap = Pick<DriveState, 'status' | 'clientTripId' | 'lastFinalized'>;

function fakeHost(initial: Snap = { status: 'idle', clientTripId: null, lastFinalized: null }) {
  let snap = initial;
  const fns = new Set<(s: DriveState) => void>();
  const host = {
    snapshot: () => snap as DriveState,
    subscribe: (fn: (s: DriveState) => void) => {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    set(next: Partial<Snap>) {
      snap = { ...snap, ...next };
      for (const fn of [...fns]) fn(snap as DriveState);
    },
    listeners: () => fns.size,
  };
  return host as typeof host & Pick<DriveHost, 'subscribe' | 'snapshot'>;
}

const recording = (id: string): Snap => ({ status: 'recording', clientTripId: id, lastFinalized: null });

test('the copy, the identifier per drive, and a tap that opens the driving screen by the recording note’s path', () => {
  expect(phoneReminderCopy).toEqual({
    title: 'Phone down while you drive',
    body: "Picking up your phone counts against this drive's score. Not the driver? Tap to let us know.",
  });
  expect(phoneReminderIdentifier(A)).toBe(`phone-reminder:${A}`);
  expect(PHONE_REMINDER_GAP_S).toBe(120);
  expect(drivingHrefOf({ kind: PHONE_REMINDER_KIND, url: DRIVE_HREF, clientTripId: A })).toBe('/drive');
});

test('posts for a pickup of the drive recording, once permission was given (never asked); a refusal posts nothing', async () => {
  const port = fakePort();
  const host = fakeHost(recording(A));
  const r = createPhoneReminder({ port });
  r.attach(host);
  r.pickup({ clientTripId: A, at: T0 });
  await r.settled();
  expect(port.posts).toEqual([{ identifier: `phone-reminder:${A}`, clientTripId: A, ...phoneReminderCopy }]);

  const denied = fakePort(false);
  const r2 = createPhoneReminder({ port: denied });
  r2.attach(fakeHost(recording(A)));
  r2.pickup({ clientTripId: A, at: T0 });
  await r2.settled();
  expect(denied.posts).toEqual([]);
});

test('at most one per 120 s of each drive: a pickup 119 s after the last reminder posts nothing, 120 s after it replaces it', async () => {
  const port = fakePort();
  const host = fakeHost(recording(A));
  const r = createPhoneReminder({ port });
  r.attach(host);
  r.pickup({ clientTripId: A, at: T0 });
  r.pickup({ clientTripId: A, at: T0 + 30_000 });
  r.pickup({ clientTripId: A, at: T0 + 119_999 });
  r.pickup({ clientTripId: A, at: T0 + 120_000 });
  r.pickup({ clientTripId: A, at: T0 + 200_000 });
  await r.settled();
  expect(port.posts.map((p) => p.identifier)).toEqual([`phone-reminder:${A}`, `phone-reminder:${A}`]);
  expect(port.shown).toEqual([{ identifier: `phone-reminder:${A}`, clientTripId: A }]);
});

test('taken down as its drive stops recording (ended, discarded, cancelled), and the next drive starts afresh', async () => {
  const port = fakePort();
  const host = fakeHost(recording(A));
  const r = createPhoneReminder({ port });
  const detach = r.attach(host);
  r.pickup({ clientTripId: A, at: T0 });
  await r.settled();
  host.set({ status: 'finalizing' });
  await r.settled();
  expect(port.cancels).toEqual([`phone-reminder:${A}`]);
  expect(port.shown).toEqual([]);
  host.set({ status: 'idle', clientTripId: null, lastFinalized: { clientTripId: A, ok: true, status: 'pending', dropped: null, endCause: 'manual', at: T0 + 1, durationS: 600, miles: 5 } });
  host.set(recording(B));
  r.pickup({ clientTripId: B, at: T0 + 10_000 });
  await r.settled();
  expect(port.shown).toEqual([{ identifier: `phone-reminder:${B}`, clientTripId: B }]);
  // "Not driving?": recording → finalizing → idle with the cancel's outcome.
  host.set({ status: 'finalizing' });
  host.set({ status: 'idle', clientTripId: null, lastFinalized: { clientTripId: B, ok: true, status: null, dropped: 'cancelled', endCause: 'manual', at: T0 + 2, durationS: null, miles: null } });
  await r.settled();
  expect(port.shown).toEqual([]);
  detach();
  expect(host.listeners()).toBe(0);
});

test('a finalize the host reports for a drive it never showed recording (a journal read at launch) takes that drive’s reminder down', async () => {
  const port = fakePort();
  port.shown = [{ identifier: `phone-reminder:${A}`, clientTripId: A }];
  const host = fakeHost();
  const r = createPhoneReminder({ port });
  r.attach(host);
  const failed: LastFinalized = { clientTripId: A, ok: false, at: T0 };
  host.set({ lastFinalized: failed });
  await r.settled();
  expect(port.cancels).toEqual([`phone-reminder:${A}`]);
});

test('a pickup whose drive has stopped recording by the time it would post posts nothing', async () => {
  const port = fakePort();
  const host = fakeHost(recording(A));
  const r = createPhoneReminder({ port });
  r.attach(host);
  r.pickup({ clientTripId: A, at: T0 });
  host.set({ status: 'idle', clientTripId: null });
  await r.settled();
  expect(port.posts).toEqual([]);
});

test('the sweep after a launch takes down every reminder but the recording drive’s; the wipe takes down all', async () => {
  const port = fakePort();
  port.shown = [
    { identifier: `phone-reminder:${A}`, clientTripId: A },
    { identifier: `phone-reminder:${B}`, clientTripId: B },
    { identifier: 'phone-reminder:x', clientTripId: null },
  ];
  const host = fakeHost(recording(B));
  const r = createPhoneReminder({ port });
  r.attach(host);
  r.sweep();
  await r.settled();
  expect(port.shown).toEqual([{ identifier: `phone-reminder:${B}`, clientTripId: B }]);
  await cancelPhoneReminders(port);
  expect(port.shown).toEqual([]);
});

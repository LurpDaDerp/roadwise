// The OS port of the recap notification: the handover wipe finds recaps already delivered (posted
// with no trigger, they never sit in the pending queue), and only drive summaries.
import { cancelDriveSummaries, createExpoSummaryPort, SUMMARY_CHANNEL_ID } from '@/features/drive/summaryNotifier';

const mockOs = {
  pending: [] as unknown[],
  presented: [] as unknown[],
  presentedFails: false,
  cancelled: [] as string[],
  dismissed: [] as string[],
  posted: [] as unknown[],
};

jest.mock('expo-notifications', () => ({
  getAllScheduledNotificationsAsync: async () => mockOs.pending,
  getPresentedNotificationsAsync: async () => {
    if (mockOs.presentedFails) throw new Error('not available');
    return mockOs.presented;
  },
  cancelScheduledNotificationAsync: async (id: string) => void mockOs.cancelled.push(id),
  dismissNotificationAsync: async (id: string) => void mockOs.dismissed.push(id),
  scheduleNotificationAsync: async (req: unknown) => {
    mockOs.posted.push(req);
    return 'id';
  },
}));

jest.mock('@/features/notifications/categories', () => ({ ensureNotificationSetup: async () => {} }));

const request = (identifier: string, kind: string) => ({ identifier, content: { data: { kind } }, trigger: null });
const delivered = (identifier: string, kind: string) => ({ date: 1, request: request(identifier, kind) });

beforeEach(() => {
  mockOs.pending = [];
  mockOs.presented = [];
  mockOs.presentedFails = false;
  mockOs.cancelled = [];
  mockOs.dismissed = [];
  mockOs.posted = [];
});

// Android takes the channel only from the trigger: in the content it is ignored and the recap lands
// on expo's fallback (high-importance) channel instead of the drive-recap one.
test('a recap posts at once on the drive-recap channel, named in the trigger', async () => {
  await createExpoSummaryPort().schedule({ identifier: 'drive-summary:a', clientTripId: 'a', title: 't', body: 'b', url: '/drives/a?fresh=1' });
  expect(mockOs.posted).toHaveLength(1);
  const req = mockOs.posted[0] as { trigger: unknown; content: Record<string, unknown> };
  expect(req.trigger).toEqual({ channelId: SUMMARY_CHANNEL_ID });
  expect(SUMMARY_CHANNEL_ID).toBe('trips');
  expect(req.content).not.toHaveProperty('channelId');
});

test('scheduled() lists the recaps in Notification Center as well as the pending ones, each once, and only drive summaries', async () => {
  mockOs.pending = [request('drive-summary:a', 'driveSummary'), request('friend-2', 'friend_request')];
  mockOs.presented = [delivered('drive-summary:b', 'driveSummary'), delivered('drive-summary:a', 'driveSummary'), delivered('friend-1', 'friend_request')];
  expect(await createExpoSummaryPort().scheduled()).toEqual(['drive-summary:a', 'drive-summary:b']);
});

test('the handover wipe takes a delivered recap down and leaves other notifications alone', async () => {
  mockOs.presented = [delivered('drive-summary:b', 'driveSummary'), delivered('friend-1', 'friend_request')];
  await cancelDriveSummaries();
  expect(mockOs.dismissed).toEqual(['drive-summary:b']);
  expect(mockOs.cancelled).toEqual(['drive-summary:b']);
});

test('a delivered list that cannot be read still leaves the pending ones to cancel', async () => {
  mockOs.pending = [request('drive-summary:a', 'driveSummary')];
  mockOs.presentedFails = true;
  expect(await createExpoSummaryPort().scheduled()).toEqual(['drive-summary:a']);
});

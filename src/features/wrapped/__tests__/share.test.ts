import { Share } from 'react-native';

import { shareWrapped } from '../share';

jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn(async () => '/tmp/ReactNative/wrapped.png') }));
const mockCreate = jest.fn(async () => 'Ab3dEf7hJk9m');
jest.mock('@/data/server/wrapped', () => ({ createWrappedShare: () => mockCreate() }));
const mockRemove = jest.fn();
jest.mock('@/lib/shareImages', () => ({ removeShareImage: (uri: string) => mockRemove(uri) }));

const core = { month: '2026-10', archetype: 'spotless_commuter' } as never;
const card = { current: null };

beforeEach(() => {
  mockRemove.mockClear();
  jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
});
afterEach(() => jest.restoreAllMocks());

test('the captured Wrapped image is deleted once the sheet closes', async () => {
  await shareWrapped(card, core);
  expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({ url: '/tmp/ReactNative/wrapped.png' }));
  expect(mockRemove).toHaveBeenCalledWith('/tmp/ReactNative/wrapped.png');
});

test('a link or sheet that fails still deletes the image, and the failure reaches the caller', async () => {
  mockCreate.mockRejectedValueOnce(new Error('offline'));
  await expect(shareWrapped(card, core)).rejects.toThrow('offline');
  expect(Share.share).not.toHaveBeenCalled();
  expect(mockRemove).toHaveBeenCalledWith('/tmp/ReactNative/wrapped.png');
});

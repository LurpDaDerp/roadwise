import { renderHook } from '@testing-library/react-native';
import { AccessibilityInfo, Platform } from 'react-native';

import { useAnnounce, type AnnounceOptions } from '@/ui';

let say: jest.SpyInstance;
let sayQueued: jest.SpyInstance;
beforeEach(() => {
  // RN's Jest preset already makes these mocks (spyOn hands the same ones back), so clear their calls.
  jest.clearAllMocks();
  say = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  sayQueued = jest.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

async function line(text: string | null | undefined, opts?: AnnounceOptions) {
  return renderHook(({ t, o }: { t: string | null | undefined; o?: AnnounceOptions }) => useAnnounce(t, o), { initialProps: { t: text, o: opts } });
}

describe('iPhone (VoiceOver)', () => {
  it('says a line once as it appears, queued behind what VoiceOver is saying; the same words on a re-render say nothing more', async () => {
    const r = await line(null);
    expect(sayQueued).not.toHaveBeenCalled();
    await r.rerender({ t: 'That email and password don’t match.' });
    expect(sayQueued).toHaveBeenCalledTimes(1);
    expect(sayQueued).toHaveBeenCalledWith('That email and password don’t match.', { queue: true });
    await r.rerender({ t: 'That email and password don’t match.' });
    expect(sayQueued).toHaveBeenCalledTimes(1);
    expect(say).not.toHaveBeenCalled();
  });

  it('a new line is said; cleared, nothing is said; the same words again after a clear are said again', async () => {
    const r = await line('First');
    await r.rerender({ t: 'Second' });
    await r.rerender({ t: null });
    await r.rerender({ t: 'Second' });
    expect(sayQueued.mock.calls.map(([text]) => text)).toEqual(['First', 'Second', 'Second']);
  });

  it('nothing for an empty line or undefined', async () => {
    const r = await line('');
    await r.rerender({ t: undefined });
    expect(sayQueued).not.toHaveBeenCalled();
  });

  it('iosOnly still speaks on iOS', async () => {
    await line('Taken', { iosOnly: true });
    expect(sayQueued).toHaveBeenCalledWith('Taken', { queue: true });
  });
});

describe('Android (TalkBack)', () => {
  let os: jest.ReplaceProperty<typeof Platform.OS>;
  beforeEach(() => {
    os = jest.replaceProperty(Platform, 'OS', 'android');
  });
  afterEach(() => os.restore());

  it('says a line once as it appears', async () => {
    const r = await line(null);
    await r.rerender({ t: 'That code is wrong or has expired.' });
    await r.rerender({ t: 'That code is wrong or has expired.' });
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith('That code is wrong or has expired.');
    expect(sayQueued).not.toHaveBeenCalled();
  });

  it('iosOnly says nothing: a live region already reads that line on Android', async () => {
    const r = await line('Taken', { iosOnly: true });
    await r.rerender({ t: 'Available', o: { iosOnly: true } });
    expect(say).not.toHaveBeenCalled();
    expect(sayQueued).not.toHaveBeenCalled();
  });
});

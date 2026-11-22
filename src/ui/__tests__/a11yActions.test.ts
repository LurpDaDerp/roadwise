import { Platform } from 'react-native';

import { withActivate } from '@/ui';

const dismiss = { name: 'dismiss', label: 'Not now' };

test('iOS: only the actions given, so VoiceOver never reads a raw "activate" among them', () => {
  expect(withActivate(dismiss)).toEqual([dismiss]);
  expect(withActivate()).toEqual([]);
});

test('Android: activate first, for TalkBack’s double-tap, then the actions given', () => {
  const os = jest.replaceProperty(Platform, 'OS', 'android');
  try {
    expect(withActivate(dismiss)).toEqual([{ name: 'activate' }, dismiss]);
    expect(withActivate()).toEqual([{ name: 'activate' }]);
  } finally {
    os.restore();
  }
});

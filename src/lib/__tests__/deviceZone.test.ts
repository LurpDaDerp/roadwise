import { deviceZone } from '@/lib/deviceZone';

const withZone = (timeZone: string | undefined, run: () => void) => {
  const spy = jest
    .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
    .mockReturnValue({ timeZone } as Intl.ResolvedDateTimeFormatOptions);
  try {
    run();
  } finally {
    spy.mockRestore();
  }
};

test('a named zone is kept', () => {
  withZone('Asia/Tokyo', () => expect(deviceZone()).toBe('Asia/Tokyo'));
});

test('an offset id is normalised the way a drive’s zone is (final review m2)', () => {
  withZone('GMT+05:00', () => expect(deviceZone()).toBe('Etc/GMT-5'));
});

test('none, or one that cannot be read, is UTC', () => {
  withZone(undefined, () => expect(deviceZone()).toBe('UTC'));
  withZone('Not/AZone', () => expect(deviceZone()).toBe('UTC'));
});

import { sameCarUid } from '../carUid';

describe('sameCarUid', () => {
  test('the same uid is the same car (iPhone port uids and Android Auto too)', () => {
    expect(sameCarUid('00:11:22:33:AB:CD', '00:11:22:33:AB:CD')).toBe(true);
    expect(sameCarUid('5C:1D:D9:00:00:01-tacl', '5C:1D:D9:00:00:01-tacl')).toBe(true);
    expect(sameCarUid('android-auto', 'android-auto')).toBe(true);
  });

  test('Android 14+: a hidden address is the full one ending in the same two bytes, either way round', () => {
    expect(sameCarUid('XX:XX:XX:XX:AB:CD', '00:11:22:33:AB:CD')).toBe(true);
    expect(sameCarUid('00:11:22:33:AB:CD', 'XX:XX:XX:XX:AB:CD')).toBe(true);
    expect(sameCarUid('XX:XX:XX:XX:AB:CE', '00:11:22:33:AB:CD')).toBe(false);
    // Two hidden forms, or two full addresses, are only the same when equal.
    expect(sameCarUid('XX:XX:XX:XX:AB:CD', 'XX:XX:XX:XX:AB:CE')).toBe(false);
    expect(sameCarUid('00:11:22:33:AB:CD', '99:11:22:33:AB:CD')).toBe(false);
  });

  test('iPhone uids never take either form: plain equality', () => {
    expect(sameCarUid('XX:XX:XX:XX:AB:CD', '00:11:22:33:AB:CD-tacl')).toBe(false);
    expect(sameCarUid('00:11:22:33:AB:CD-tacl', '00:11:22:33:AB:CD-tsco')).toBe(false);
    expect(sameCarUid('carplay-uid', 'other')).toBe(false);
  });
});

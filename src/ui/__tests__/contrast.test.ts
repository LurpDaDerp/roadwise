import { contrastRatio, relativeLuminance } from '@/ui/contrast';

test('black on white is 21:1', () => expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1));
test('luminance of white is 1', () => expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6));
test('symmetric', () =>
  expect(contrastRatio('#123456', '#abcdef')).toBeCloseTo(contrastRatio('#abcdef', '#123456'), 6));

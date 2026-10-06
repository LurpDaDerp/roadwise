import { contrastRatio } from '@/ui';

import { CLAN_BANNERS } from '../types';
import { BANNER_ART, bannerArt } from '../banners';

test.each(CLAN_BANNERS)('%s: name and secondary ink read on both gradient stops', (b) => {
  const art = BANNER_ART[b];
  for (const stop of art.face) {
    expect(contrastRatio(art.ink, stop)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(art.inkMuted, stop)).toBeGreaterThanOrEqual(4.5);
  }
});

test('an unknown banner falls back to navy', () => {
  expect(bannerArt('plaid')).toBe(BANNER_ART.navy);
});

/**
 * Clan banner art: the eight server presets as two-stop gradients with the ink drawn on them.
 * These are artwork, not UI colour roles, so they live with the feature rather than in the theme;
 * `banners.test.ts` holds every ink at >= 4.5:1 on both stops.
 */
import type { ClanBanner } from './types';

export interface BannerArt {
  label: string;
  face: [string, string];
  /** Name and numbers on the face. */
  ink: string;
  /** Secondary text and the watermark glyph. */
  inkMuted: string;
}

export const BANNER_ART: Record<ClanBanner, BannerArt> = {
  navy: { label: 'Navy', face: ['#003566', '#001D3D'], ink: '#FFFFFF', inkMuted: '#C9D8EA' },
  gold: { label: 'Gold', face: ['#FFD60A', '#FFC300'], ink: '#001D3D', inkMuted: '#3A2E00' },
  sunset: { label: 'Sunset', face: ['#B8325A', '#7A1F4B'], ink: '#FFFFFF', inkMuted: '#FFE0EA' },
  forest: { label: 'Forest', face: ['#1F6B45', '#0E4229'], ink: '#FFFFFF', inkMuted: '#D3F2E0' },
  ocean: { label: 'Ocean', face: ['#0F6F8F', '#08445C'], ink: '#FFFFFF', inkMuted: '#D2EEF7' },
  violet: { label: 'Violet', face: ['#5B3FA8', '#37226F'], ink: '#FFFFFF', inkMuted: '#E4DCFA' },
  ember: { label: 'Ember', face: ['#B3401A', '#7A2508'], ink: '#FFFFFF', inkMuted: '#FFE1D4' },
  slate: { label: 'Slate', face: ['#4A5A6E', '#2B3645'], ink: '#FFFFFF', inkMuted: '#DCE3EC' },
};

/** Unknown banners (a newer server) fall back to navy. */
export function bannerArt(banner: string): BannerArt {
  return BANNER_ART[banner as ClanBanner] ?? BANNER_ART.navy;
}

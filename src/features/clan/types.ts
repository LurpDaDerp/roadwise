/** Clan constants with no runtime imports, so pure modules and their tests stay light. */
export const CLAN_BANNERS = ['navy', 'gold', 'sunset', 'forest', 'ocean', 'violet', 'ember', 'slate'] as const;
export type ClanBanner = (typeof CLAN_BANNERS)[number];
export type ClanRole = 'leader' | 'coleader' | 'member';
export type ReportReason = 'inappropriate_name' | 'harassment' | 'cheating' | 'impersonation' | 'other';

/** Clan routes, typed against Expo Router's generated union. */
import type { Href } from 'expo-router';

export const CLAN_TAB_HREF: Href = '/(tabs)/clan';
export const CLAN_CREATE_HREF: Href = '/(app)/clan/create';
export const CLAN_MANAGE_HREF: Href = '/(app)/clan/manage';

export const clanJoinHref = (code?: string): Href =>
  code ? { pathname: '/(app)/clan/join', params: { code } } : '/(app)/clan/join';

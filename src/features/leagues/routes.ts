/** Where a board row leads. Typed against Expo Router's generated route union. */
import type { Href } from 'expo-router';

/** A player's public profile (WP9 builds the screen). */
export const profileHref = (username: string): Href => ({
  pathname: '/(app)/u/[username]',
  params: { username },
});

export const FRIENDS_ADD_HREF: Href = '/(app)/friends/add';

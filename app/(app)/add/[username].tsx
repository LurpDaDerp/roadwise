import { Redirect, useLocalSearchParams, type Href } from 'expo-router';

import { profileHref, USERNAME_RE } from '@/features/social/links';

/**
 * The friend link `roadwise://add/<username>` opens here and lands on that driver's profile, where
 * the friend request is one tap. Anything that isn't a username goes to Friends instead.
 */
export default function AddFriendLinkRoute() {
  const { username } = useLocalSearchParams<{ username?: string | string[] }>();
  const name = typeof username === 'string' ? username.toLowerCase() : '';
  return <Redirect href={USERNAME_RE.test(name) ? profileHref(name) : ('/friends' as Href)} />;
}

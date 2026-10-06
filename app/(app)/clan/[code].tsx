import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * The invite link `roadwise://clan/<code>` opens here and lands on the join preview. Invite codes
 * are 8 upper-case letters and digits, so they never collide with `create`, `join` or `manage`.
 */
export default function ClanInviteLinkRoute() {
  const { code } = useLocalSearchParams<{ code: string }>();
  return <Redirect href={{ pathname: '/(app)/clan/join', params: { code: typeof code === 'string' ? code : '' } }} />;
}

// Cleanup for the integration tests that write real rows to the local stack.
import type { Sql } from 'postgres';

/**
 * Removes an integration-test user and everything it owns. The auth row cascades through every
 * user-owned table, but a league group is not user-owned: the group the user was placed in keeps
 * counting them after they are gone, and a later pgTAP run (0007: a group fills to 30) would fill
 * the phantom seat. So the user is taken out of their groups' counts once the row is gone, and a
 * group left with nobody in it goes too (a group never exists without a member otherwise).
 */
export async function deleteTestUser(sql: Sql, userId: string): Promise<void> {
  const groups = await sql<{ group_id: string }[]>`select group_id from public.league_members where user_id = ${userId}::uuid`;
  const ids = groups.map((g) => g.group_id);
  await sql`delete from auth.users where id = ${userId}::uuid`;
  if (ids.length === 0) return;
  await sql`update public.league_groups set member_count = greatest(0, member_count - 1) where id = any(${ids}::uuid[])`;
  await sql`delete from public.league_groups where id = any(${ids}::uuid[]) and member_count = 0`;
}

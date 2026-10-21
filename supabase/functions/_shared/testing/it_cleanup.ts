// Cleanup for the integration tests that write real rows to the local stack.
import type { Sql } from 'postgres';

/** Removes an integration-test user and everything it owns: the auth row cascades through every user-owned table. */
export async function deleteTestUser(sql: Sql, userId: string): Promise<void> {
  await sql`delete from auth.users where id = ${userId}::uuid`;
}

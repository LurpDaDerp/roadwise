/**
 * Server errors in words a teen reads once and understands. The SQL raises fixed messages
 * (`supabase/migrations/0001_core.sql`, `0006_social.sql`); each known one maps to a line here.
 * Anything else is either "couldn't reach RoadWise" (no RpcError: the request never landed) or a
 * plain "try again".
 */
import { RpcError } from '@/data/server/rpc';

const KNOWN: readonly (readonly [string, string])[] = [
  ['too many requests', "That's a lot of tries. Wait a minute, then try again."],
  ['profile not found', "We couldn't find that driver."],
  ['you have reached the friend limit', "You've hit the 200-friend limit. Remove someone to add someone new."],
  ['that user has reached the friend limit', "They've hit the friend limit, so you can't add them right now."],
  ['no such request', "That request isn't there anymore."],
  ['not friends', "You're not friends anymore."],
  ['you have reached the block limit', "You've blocked as many people as you can."],
  ['not blocked', "They're already unblocked."],
  ['username is taken', 'Someone already has that username. Try another.'],
  ['username must be 3 to 20 letters, digits or underscores', 'Use 3 to 20 letters, numbers or underscores.'],
  ['username must be 3 to 20 characters', 'Use 3 to 20 letters, numbers or underscores.'],
  ['unknown report reason', 'Pick a reason for the report.'],
];

export const NETWORK_ERROR = "Couldn't reach RoadWise. Check your connection and try again.";
export const GENERIC_ERROR = 'Something went wrong. Try again.';

/** The line to show for a failed server call. */
export function friendlyError(error: unknown): string {
  if (!(error instanceof RpcError)) return NETWORK_ERROR;
  const message = error.message.toLowerCase();
  for (const [needle, line] of KNOWN) if (message.includes(needle)) return line;
  return GENERIC_ERROR;
}

/** The server said "not found" (also how a block looks from either side). */
export function isNotFound(error: unknown): boolean {
  return error instanceof RpcError && (error.code === 'P0002' || /not found/i.test(error.message));
}

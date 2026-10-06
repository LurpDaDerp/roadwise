/**
 * Pure clan logic: member sorting, the weekly goal, name and code checks, invite text, who may do
 * what, who leads after the leader leaves, and friendly error copy. No React.
 */
import type { RpcError } from '@/data/server/rpc';
import { distanceIn, distanceWord, type Units } from '@/lib/units';
import { formatPointsValue } from '@/ui';

import { ratingText } from '../leagues/model';

import type { ClanMember, ClanRole, MyClan } from './api';

// ---------------------------------------------------------------------------
// sorting
// ---------------------------------------------------------------------------

export type MemberSort = 'rating' | 'points' | 'week' | 'miles' | 'clean' | 'streak';

export const MEMBER_SORTS: readonly { key: MemberSort; label: string }[] = [
  { key: 'rating', label: 'Safety Rating' },
  { key: 'points', label: 'Points' },
  { key: 'week', label: 'This week' },
  { key: 'miles', label: 'Distance' },
  { key: 'clean', label: 'Clean %' },
  { key: 'streak', label: 'Streak' },
];

/** The number a sort ranks by; null sorts last (unranked rating, no drives for clean %). */
export function memberSortValue(m: ClanMember, key: MemberSort): number | null {
  switch (key) {
    case 'rating':
      return m.ranked ? m.safety_rating : null;
    case 'points':
      return m.points;
    case 'week':
      return m.week_points;
    case 'miles':
      return m.miles_30d;
    case 'clean':
      return m.clean_pct;
    case 'streak':
      return m.streak;
  }
}

/** Highest first; missing values last; ties by username so the order never jitters. */
export function sortMembers(members: readonly ClanMember[], key: MemberSort): ClanMember[] {
  return [...members].sort((a, b) => {
    const va = memberSortValue(a, key);
    const vb = memberSortValue(b, key);
    if (va === null && vb !== null) return 1;
    if (vb === null && va !== null) return -1;
    if (va !== null && vb !== null && va !== vb) return vb - va;
    return a.username.localeCompare(b.username);
  });
}

/** What a member row shows on the right for the chosen sort. */
export function memberStat(m: ClanMember, key: MemberSort, units: Units = 'mi'): { value: string; unit?: string; spoken: string } {
  switch (key) {
    case 'rating': {
      const v = ratingText(m.safety_rating, m.ranked);
      return { value: v, spoken: `Safety Rating ${v}` };
    }
    case 'points':
      return { value: formatPointsValue(m.points), unit: 'pts', spoken: `${formatPointsValue(m.points)} points` };
    case 'week':
      return {
        value: formatPointsValue(m.week_points),
        unit: 'this week',
        spoken: `${formatPointsValue(m.week_points)} points this week`,
      };
    case 'miles': {
      // Floored like every other whole distance (Home, Profile, the goal).
      const v = Math.floor(distanceIn(m.miles_30d, units)).toLocaleString('en-US');
      return { value: v, unit: units, spoken: `${v} ${distanceWord(units)} in 30 days` };
    }
    case 'clean':
      return m.clean_pct === null
        ? { value: '–', unit: 'clean', spoken: 'No drives in 30 days' }
        : { value: `${m.clean_pct}%`, unit: 'clean', spoken: `${m.clean_pct} percent clean drives` };
    case 'streak':
      return { value: String(m.streak), unit: 'streak', spoken: `${m.streak} drive streak` };
  }
}

// ---------------------------------------------------------------------------
// the weekly goal
// ---------------------------------------------------------------------------

export function goalProgress(goal: MyClan['goal'], units: Units = 'mi'): { fraction: number; text: string; done: boolean } {
  const miles = Math.max(0, Math.floor(goal.clean_miles));
  const target = Math.max(1, goal.target_clean_miles);
  const shown = Math.floor(distanceIn(miles, units));
  const shownTarget = Math.round(distanceIn(target, units));
  const word = units === 'km' ? 'clean km' : 'clean miles';
  return {
    fraction: Math.min(1, miles / target),
    text: `${shown.toLocaleString('en-US')} / ${shownTarget.toLocaleString('en-US')} ${word} this week`,
    done: miles >= target,
  };
}

// ---------------------------------------------------------------------------
// names and codes
// ---------------------------------------------------------------------------

export const CLAN_NAME_MIN = 3;
export const CLAN_NAME_MAX = 24;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.'-]*[A-Za-z0-9.]$/;

export type NameProblem = 'length' | 'characters';

/** The server's shape rules (`private.clan_name_problem`); the word filter only runs there. */
export function validateClanName(raw: string): NameProblem | null {
  const name = raw.trim();
  if (name.length < CLAN_NAME_MIN || name.length > CLAN_NAME_MAX) return 'length';
  if (!NAME_RE.test(name) || name.includes('  ')) return 'characters';
  return null;
}

export const NAME_PROBLEM_COPY: Record<NameProblem, string> = {
  length: `Use ${CLAN_NAME_MIN} to ${CLAN_NAME_MAX} characters.`,
  characters: "Use letters, numbers, spaces and . _ ' -, starting with a letter or number.",
};

const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

/** Upper-cased, without spaces or dashes; a pasted invite link gives up its code. */
export function normalizeCode(input: string): string {
  const fromLink = /clan\/([A-Za-z0-9-]+)/.exec(input);
  return (fromLink?.[1] ?? input).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidCode(code: string): boolean {
  return CODE_RE.test(code);
}

export const inviteLink = (code: string) => `roadwise://clan/${code}`;

export function inviteMessage(clanName: string, code: string): string {
  return `Join my clan ${clanName} on RoadWise! Code: ${code}\n${inviteLink(code)}`;
}

// ---------------------------------------------------------------------------
// roles and who may do what
// ---------------------------------------------------------------------------

export const ROLE_LABEL: Record<ClanRole, string> = { leader: 'Leader', coleader: 'Co-leader', member: 'Member' };

export type ManageAction = 'promote' | 'demote' | 'transfer' | 'remove';

/**
 * What I can do to another member, mirroring the server: the leader promotes, demotes, hands
 * over leadership and removes anyone; a co-leader removes members only (not other co-leaders).
 */
export function manageActions(myRole: ClanRole, target: Pick<ClanMember, 'role'>): ManageAction[] {
  if (target.role === 'leader') return [];
  if (myRole === 'leader') return [target.role === 'coleader' ? 'demote' : 'promote', 'transfer', 'remove'];
  if (myRole === 'coleader' && target.role === 'member') return ['remove'];
  return [];
}

/**
 * Who leads after the leader leaves, as `clan_member_gone` picks: the longest-serving co-leader,
 * else the longest-serving member. Null when nobody is left (the clan is deleted).
 */
export function nextLeaderAfterLeave(members: readonly ClanMember[], myId: string): ClanMember | null {
  const others = members.filter((m) => m.user_id !== myId);
  if (others.length === 0) return null;
  return [...others].sort(
    (a, b) =>
      Number(b.role === 'coleader') - Number(a.role === 'coleader') ||
      Date.parse(a.joined_at) - Date.parse(b.joined_at) ||
      a.user_id.localeCompare(b.user_id)
  )[0] ?? null;
}

/** The confirm text for Leave clan. */
export function leaveMessage(clan: Pick<MyClan, 'clan' | 'my_role' | 'members'>, myId: string): string {
  if (clan.my_role !== 'leader') return 'You can join again later with an invite code.';
  if (clan.clan.member_count <= 1) return "You're the only member, so the clan will be deleted.";
  // members I've blocked are hidden from me but still count, and one of them may be next in line
  const hidden = clan.clan.member_count > clan.members.length;
  const next = hidden ? null : nextLeaderAfterLeave(clan.members, myId);
  const who = next ? next.username : 'the longest-serving co-leader (or member)';
  return `You're the leader. If you leave, ${who} becomes the leader automatically.`;
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export const GENERIC_ERROR = 'Something went wrong. Check your connection and try again.';

const SERVER_MESSAGES: Record<string, string> = {
  'clan name is taken': 'That name is taken. Try another one.',
  // shape is checked on the phone first, so this is the word filter
  'name must be 3 to 24 characters': "That name isn't allowed. Try another one.",
  'unknown banner': 'Pick a banner.',
  'you are already in a clan': "You're already in a clan. Leave it first to start or join another.",
  'clan not found': "We couldn't find a clan with that code. Check it and try again.",
  'code must be 8 characters': 'Clan codes are 8 letters and numbers.',
  'this clan is full': 'This clan is full. Clans max out at 30 members.',
  'you cannot join this clan': "You can't join this clan.",
  'you are not in a clan': "You're not in a clan anymore.",
  'only the leader can do that': 'Only the leader can do that.',
  'only the leader or a co-leader can do that': 'Only the leader or a co-leader can do that.',
  'member not found': "That player isn't in your clan anymore.",
  'too many requests': "That's a lot of tries. Wait a bit and try again.",
  'you have reached the block limit': "You've blocked as many people as you can. Unblock someone in Settings first.",
};

// by name, so this module stays pure (importing `RpcError` would load the Supabase client)
function isRpcError(err: unknown): err is RpcError {
  return err instanceof Error && err.name === 'RpcError';
}

/** Where the call came from, when the same server message means different things. */
export type ErrorContext = 'clan' | 'report';

const REPORT_MESSAGES: Record<string, string> = {
  'clan not found': "That clan doesn't exist anymore.",
  'profile not found': "That player isn't around anymore.",
};

/** Friendly copy for a failed clan, block or report call. Never shows a raw server message. */
export function friendlyError(err: unknown, context: ErrorContext = 'clan'): string {
  if (!isRpcError(err)) return GENERIC_ERROR;
  const own = context === 'report' ? REPORT_MESSAGES[err.message] : undefined;
  return own ?? SERVER_MESSAGES[err.message] ?? GENERIC_ERROR;
}

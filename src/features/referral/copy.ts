/**
 * F10's words: inviting friends, using a friend's code, and the join link.
 *
 * - **Points are never money.** The explainer carries the shared `NOT_MONEY` sentence.
 * - **Nothing about the other person.** The inviter sees counts; the friend sees only whether
 *   their code counted. No name, id or date appears anywhere, and the share text is built from the
 *   code and the store link alone.
 * - **Refusals say nothing about whether a code exists** (rev1 R-D, controller carry): a wrong
 *   code, a closed window, a code already used and a spent budget all read "That code didn't work."
 *   Why a friend's code cannot be used is said by the status (`explain`, from `my_referrals`), which
 *   is about the caller's own account, never about the code typed.
 * - **"Use code", never "redeem"** (BANNED_COPY). Neutral wording, open to 13–17-year-olds (D9).
 */
import { REWARDS } from '@scoring';

import { BUSY_LINE, NOT_MONEY, pointsText } from '@/features/rewards/copy/common';

import type { MyCodeStatus, ReferralErrorCode } from './api';

const POINTS = pointsText(REWARDS.POINTS.referral);
const DRIVES = REWARDS.REFERRAL.QUALIFYING_DRIVES;
const CAP = REWARDS.REFERRAL.YEARLY_CAP;
const WINDOW_D = REWARDS.REFERRAL.REDEEM_WITHIN_D;
const QUALIFY_D = REWARDS.REFERRAL.QUALIFY_WITHIN_D;

const UNAVAILABLE = "Invites aren't available yet.";
const REFUSED = "That code didn't work.";

export const referralCopy = {
  back: 'Back',
  done: 'Done',
  retry: 'Try again',
  loading: 'Loading your invites',
  unavailable: UNAVAILABLE,
  offline: "You're offline. This is what was saved on this phone.",
  loadError: "Your invites couldn't be loaded.",
  invite: {
    title: 'Invite friends',
    codeLabel: 'Your code',
    codeSpoken: (spoken: string) => `Your code: ${spoken}`,
    codeError: "Your code couldn't be loaded.",
    // m1: credit comes once the drives' days are confirmed (settled), and only within 90 days.
    explainer: `You both get ${POINTS} once your friend's first ${DRIVES} scored drives are confirmed, within ${QUALIFY_D} days of using your code.`,
    notMoney: NOT_MONEY,
    yearly: `Up to ${CAP} invites a year earn points.`,
    statusLabel: 'Friends',
    cap: `You've reached this year's ${CAP} invites that earn points. Friends can still join.`,
    share: 'Share invite',
    shareHint: 'Opens the share sheet with your code',
    gotCode: 'Got a code from a friend?',
    myCodeLabel: "Your friend's code",
  },
  redeem: {
    label: "Friend's code",
    hint: '8 letters and numbers',
    submit: 'Use code',
    submitHint: "Saves your friend's code on your account",
    badPattern: "That code doesn't look right.",
    saved: `Code saved. It counts once your first ${DRIVES} scored drives are confirmed, within ${QUALIFY_D} days.`,
  },
  /** The invitee's own status (`my_referrals.myCode`). `none` has no line. */
  mine: {
    pending: `Your friend's code counts once your first ${DRIVES} scored drives are confirmed.`,
    counted: `Your friend's code counted: ${POINTS} added.`,
    not_counted: "Your friend's code didn't count this time.",
  } satisfies Record<Exclude<MyCodeStatus, 'none'>, string>,
  /** Why a friend's code can't be used on this account (`canRedeem` false). */
  explain: {
    windowClosed: `Codes can be used in your first ${WINDOW_D} days.`,
    alreadyUsed: "You've already used a friend's code.",
  },
  join: {
    title: 'Invite',
    invalid: "This invite link isn't valid.",
    question: (code: string) => `Use code ${code} from a friend?`,
    questionSpoken: (spoken: string) => `Use code ${spoken} from a friend?`,
    body: `It counts once your first ${DRIVES} scored drives are confirmed, within ${QUALIFY_D} days.`,
    use: 'Use code',
    notNow: 'Not now',
  },
  /** Each refusal's line. The four the code alone could explain read the same. */
  error: {
    offline: "You're offline. Try again when you're connected.",
    busy: BUSY_LINE,
    invalid: REFUSED,
    window_closed: REFUSED,
    already_used: REFUSED,
    too_many: REFUSED,
    own_code: "That's your own code.",
    not_available: UNAVAILABLE,
    unknown: 'Something went wrong. Try again.',
  } satisfies Record<ReferralErrorCode, string>,
} as const;

/** "ABCD2345" → "ABCD 2345": two groups of four, easier to read aloud and to copy by eye. */
export function spacedCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4)}`;
}

/** "ABCD2345" → "A, B, C, D, 2, 3, 4, 5": a screen reader says each character, never a word. */
export function spokenCode(code: string): string {
  return code.split('').join(', ');
}

/** The inviter's status: counts only. */
export function statusLine(counts: { joined: number; qualified: number }): { text: string; spoken: string } {
  if (counts.joined === 0) {
    const none = 'No one has joined with your code yet.';
    return { text: none, spoken: none };
  }
  return {
    text: `${counts.joined} joined · ${counts.qualified} counted`,
    spoken: `${counts.joined} joined, ${counts.qualified} counted`,
  };
}

/**
 * The invite text: the code, the store link when this platform has one, and the app link. Built
 * from these two values alone, so no name, id or date can reach it.
 */
export function shareMessage(code: string, storeUrl: string | null): string {
  return [
    `I'm using RoadWise to get better at driving. Join me with my code ${code}.`,
    ...(storeUrl ? [storeUrl] : []),
    `If you have the app: roadwise://join/${code}`,
  ].join('\n');
}

/** Every string above, the functions called with a sample code (for the copy rules). */
export function allCopyStrings(): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') out.push(value);
    else if (typeof value === 'function') out.push(String((value as (s: string) => unknown)('ABCD2345')));
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
  };
  walk(referralCopy);
  out.push(shareMessage('ABCD2345', 'https://apps.apple.com/app/id123'));
  out.push(statusLine({ joined: 3, qualified: 1 }).text, statusLine({ joined: 0, qualified: 0 }).text);
  return out;
}

import { NOT_MONEY } from '@/features/rewards/copy/common';
import { BANNED_COPY } from '@/notifications/catalog';

import { REFERRAL_ERROR_CODES, type ReferralErrorCode } from '../api';
import { referralCopy as copy, shareMessage, spokenCode, spacedCode, statusLine, allCopyStrings } from '../copy';

describe('referral copy', () => {
  test('the briefed strings, verbatim', () => {
    expect(copy.invite.explainer).toBe(
      "You both get 500 points once your friend's first 3 scored drives are confirmed, within 90 days of using your code."
    );
    expect(copy.invite.yearly).toBe('Up to 20 invites a year earn points.');
    expect(copy.invite.cap).toBe("You've reached this year's 20 invites that earn points. Friends can still join.");
    expect(copy.invite.share).toBe('Share invite');
    expect(copy.invite.gotCode).toBe('Got a code from a friend?');
    expect(copy.unavailable).toBe("Invites aren't available yet.");
    expect(copy.redeem.badPattern).toBe("That code doesn't look right.");
    expect(copy.redeem.saved).toBe('Code saved. It counts once your first 3 scored drives are confirmed, within 90 days.');
    expect(copy.redeem.submit).toBe('Use code');
    expect(copy.mine.pending).toBe("Your friend's code counts once your first 3 scored drives are confirmed.");
    expect(copy.mine.not_counted).toBe("Your friend's code didn't count this time.");
    expect(copy.explain.windowClosed).toBe('Codes can be used in your first 14 days.');
    expect(copy.explain.alreadyUsed).toBe("You've already used a friend's code.");
    expect(copy.join.invalid).toBe("This invite link isn't valid.");
    expect(copy.join.question('ABCD2345')).toBe('Use code ABCD2345 from a friend?');
    expect(copy.join.use).toBe('Use code');
    expect(copy.join.notNow).toBe('Not now');
    // m1: the timing names the confirmation and the 90 days, never "after 3 scored drives"
    expect(copy.join.body).toBe('It counts once your first 3 scored drives are confirmed, within 90 days.');
    for (const s of allCopyStrings()) expect(s).not.toMatch(/after (your (friend finishes|first) )?3 scored drives/);
  });

  test('every refusal has copy', () => {
    for (const code of REFERRAL_ERROR_CODES) expect(copy.error[code].length).toBeGreaterThan(0);
  });

  test('the refusals the server could tell apart only by the code read the same generic line', () => {
    // A wrong code, a closed window, a used code and an exhausted budget all read alike: nothing
    // on screen says whether a code exists (controller carry, rev1 R-D).
    const generic: ReferralErrorCode[] = ['invalid', 'window_closed', 'already_used', 'too_many'];
    for (const code of generic) expect(copy.error[code]).toBe("That code didn't work.");
    expect(copy.error.own_code).toBe("That's your own code.");
    expect(copy.error.not_available).toBe(copy.unavailable);
  });

  test('the code is printed in two groups and spoken letter by letter', () => {
    expect(spacedCode('ABCD2345')).toBe('ABCD 2345');
    expect(spokenCode('ABCD2345')).toBe('A, B, C, D, 2, 3, 4, 5');
  });

  test('the status is counts only', () => {
    expect(statusLine({ joined: 3, qualified: 1 })).toEqual({ text: '3 joined · 1 counted', spoken: '3 joined, 1 counted' });
    expect(statusLine({ joined: 0, qualified: 0 }).text).toBe('No one has joined with your code yet.');
    expect(statusLine({ joined: 1, qualified: 0 }).text).toBe('1 joined · 0 counted');
  });

  describe('the share message', () => {
    test('without a store link', () => {
      expect(shareMessage('ABCD2345', null)).toBe(
        "I'm using RoadWise to get better at driving. Join me with my code ABCD2345.\n" +
          'If you have the app: roadwise://join/ABCD2345'
      );
    });

    test('with the store link', () => {
      expect(shareMessage('ABCD2345', 'https://apps.apple.com/app/id123')).toBe(
        "I'm using RoadWise to get better at driving. Join me with my code ABCD2345.\n" +
          'https://apps.apple.com/app/id123\n' +
          'If you have the app: roadwise://join/ABCD2345'
      );
    });

    test('it is built from the code and the link alone: no name can reach it', () => {
      // The signature takes nothing else; the text carries no one's name, id or date.
      expect(shareMessage.length).toBe(2);
      const text = shareMessage('ABCD2345', null);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|@/);
    });
  });

  test('BANNED_COPY over every string (no "redeem" anywhere: the button says "Use code")', () => {
    const strings = allCopyStrings();
    expect(strings.length).toBeGreaterThan(20);
    for (const s of strings) {
      for (const re of BANNED_COPY) expect(s).not.toMatch(re);
      expect(s).not.toMatch(/redeem/i);
    }
    // the one money sentence is the shared denial, word for word
    expect(strings).toContain(NOT_MONEY);
  });
});

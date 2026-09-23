/**
 * Final review m6: the referral rule numbers the push copy states are the rules' own. The catalog
 * is self-contained (synced to Deno), so it carries a copy; this pins the copy to `REWARDS`.
 */
import { REWARDS } from '@scoring';

import { REFERRAL_COPY_RULES, renderPush } from '../catalog';

test('REFERRAL_COPY_RULES equals REWARDS.REFERRAL', () => {
  expect(REFERRAL_COPY_RULES).toEqual({
    qualifyingDrives: REWARDS.REFERRAL.QUALIFYING_DRIVES,
    qualifyWithinDays: REWARDS.REFERRAL.QUALIFY_WITHIN_D,
  });
});

test("the invitee's push states the rules' number of drives", () => {
  const copy = renderPush('referral_qualified', { role: 'invitee', points: REWARDS.POINTS.referral });
  expect(copy?.body).toBe(`You finished ${REWARDS.REFERRAL.QUALIFYING_DRIVES} scored drives. +500 points.`);
  // negative control: no other count of drives appears in it
  expect(copy?.body.match(/\d+ scored drives/g)).toEqual([`${REWARDS.REFERRAL.QUALIFYING_DRIVES} scored drives`]);
});

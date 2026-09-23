import {
  fetchMyReferrals,
  getMyReferralCode,
  MY_REFERRALS_KEYS,
  MyReferralsSchema,
  REDEEM_ERROR_MESSAGES,
  redeemReferralCode,
  ReferralError,
  referralErrorCode,
  type ReferralClient,
  type ReferralErrorCode,
} from '../api';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

interface Reply {
  data: unknown;
  error: unknown;
  status: number;
}
const ok = (data: unknown): Reply => ({ data, error: null, status: 200 });
const offline = (): Reply => ({ data: null, error: { message: 'TypeError: Network request failed', code: '' }, status: 0 });
/** Raised refusals and 0011's returned ones reach supabase-js the same way: an error body with its status. */
const refused = (code: string, message: string, status = 400): Reply => ({
  data: null,
  error: { code, details: null, hint: null, message },
  status,
});

function fakeClient(answer: (fn: string, args: unknown) => Reply | Promise<Reply>) {
  const calls: { fn: string; args: unknown }[] = [];
  const client = {
    rpc(fn: string, args?: unknown) {
      calls.push({ fn, args });
      return Promise.resolve(answer(fn, args));
    },
  } as unknown as ReferralClient;
  return { client, calls };
}

const ROW = {
  code: 'ABCD2345',
  joined: 3,
  qualified: 1,
  rewardedThisYear: 1,
  cap: 20,
  canRedeem: false,
  myCode: 'none',
};

async function codeOf(p: Promise<unknown>): Promise<ReferralErrorCode> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(ReferralError);
    return (error as ReferralError).code;
  }
  throw new Error('expected a refusal');
}

describe('my_referrals schema', () => {
  test("the key set is exactly 0011's", () => {
    expect([...MY_REFERRALS_KEYS].sort()).toEqual(
      ['code', 'joined', 'qualified', 'rewardedThisYear', 'cap', 'canRedeem', 'myCode'].sort()
    );
    expect(Object.keys(MyReferralsSchema.shape).sort()).toEqual([...MY_REFERRALS_KEYS].sort());
  });

  test('accepts a real answer, and a null code (never asked for yet)', () => {
    expect(MyReferralsSchema.parse(ROW)).toEqual(ROW);
    expect(MyReferralsSchema.parse({ ...ROW, code: null }).code).toBeNull();
  });

  test.each([
    ['an extra key (a name)', { ...ROW, name: 'Sam' }],
    ['an extra key (an id)', { ...ROW, referrer_id: '00000000-0000-4000-8000-000000000001' }],
    ['a missing key', { ...ROW, canRedeem: undefined }],
    ['a negative count', { ...ROW, joined: -1 }],
    ['a fractional count', { ...ROW, qualified: 1.5 }],
    ['an unknown status', { ...ROW, myCode: 'expired' }],
    ['a code outside the alphabet', { ...ROW, code: 'IIII1111' }],
    ['canRedeem null', { ...ROW, canRedeem: null }],
  ])('refuses %s', (_name, row) => {
    expect(MyReferralsSchema.safeParse(row).success).toBe(false);
  });
});

describe('the three calls', () => {
  test('fetchMyReferrals calls my_referrals with no arguments', async () => {
    const { client, calls } = fakeClient(() => ok(ROW));
    await expect(fetchMyReferrals(client)).resolves.toEqual(ROW);
    expect(calls).toEqual([{ fn: 'my_referrals', args: undefined }]);
  });

  test('an unreadable answer is unknown, never a partial one', async () => {
    const { client } = fakeClient(() => ok({ ...ROW, extra: 1 }));
    expect(await codeOf(fetchMyReferrals(client))).toBe('unknown');
  });

  test('getMyReferralCode returns the code', async () => {
    const { client, calls } = fakeClient(() => ok({ code: 'ABCD2345' }));
    await expect(getMyReferralCode(client)).resolves.toBe('ABCD2345');
    expect(calls).toEqual([{ fn: 'get_my_referral_code', args: undefined }]);
  });

  test('getMyReferralCode refuses an answer with anything besides the code', async () => {
    const { client } = fakeClient(() => ok({ code: 'ABCD2345', user_id: 'x' }));
    expect(await codeOf(getMyReferralCode(client))).toBe('unknown');
  });

  test('redeemReferralCode normalises what was typed before sending', async () => {
    const { client, calls } = fakeClient(() => ok({ status: 'pending' }));
    await expect(redeemReferralCode(' abcd-2345 ', client)).resolves.toEqual({ status: 'pending' });
    expect(calls).toEqual([{ fn: 'redeem_referral_code', args: { p_code: 'ABCD2345' } }]);
  });

  test.each(['IIII1111', 'ABCD234', 'ABCD23456', 'OOOO0000', ''])(
    'a code that cannot match the pattern (%p) is refused as invalid without a call',
    async (input) => {
      const { client, calls } = fakeClient(() => ok({ status: 'pending' }));
      expect(await codeOf(redeemReferralCode(input, client))).toBe('invalid');
      expect(calls).toEqual([]);
    }
  );

  test('a transport failure is offline, whether reported (status 0) or thrown', async () => {
    expect(await codeOf(fetchMyReferrals(fakeClient(() => offline()).client))).toBe('offline');
    const throwing = fakeClient(() => Promise.reject(new TypeError('Network request failed')));
    expect(await codeOf(redeemReferralCode('ABCD2345', throwing.client))).toBe('offline');
  });
});

describe('refusals', () => {
  test.each<[string, string, number, ReferralErrorCode]>([
    ['22023', 'invalid code', 400, 'invalid'],
    ['22023', 'code window closed', 400, 'window_closed'],
    ['22023', 'already used a code', 400, 'already_used'],
    ['22023', 'this is your own code', 400, 'own_code'],
    ['42501', 'too many attempts', 403, 'too_many'],
    ['42501', 'referrals are not available yet', 403, 'not_available'],
    ['42501', 'account not eligible', 403, 'not_available'],
    ['42501', 'redeem_referral_code requires an authenticated user', 403, 'unknown'],
    ['55P03', 'canceling statement due to lock timeout', 500, 'busy'],
    ['XX000', 'something else', 500, 'unknown'],
  ])('%s %s → %s', async (sqlstate, message, status, code) => {
    const { client } = fakeClient(() => refused(sqlstate, message, status));
    expect(await codeOf(redeemReferralCode('ABCD2345', client))).toBe(code);
  });

  test('every message 0011 raises or returns is mapped', () => {
    expect(Object.keys(REDEEM_ERROR_MESSAGES).sort()).toEqual(
      [
        'account not eligible',
        'already used a code',
        'code window closed',
        'get_my_referral_code requires an authenticated user',
        'invalid code',
        'my_referrals requires an authenticated user',
        'redeem_referral_code requires an authenticated user',
        'referrals are not available yet',
        'this is your own code',
        'too many attempts',
      ].sort()
    );
  });

  test('referralErrorCode: status 0 wins; a non-object is unknown', () => {
    expect(referralErrorCode({ message: 'invalid code' }, 0)).toBe('offline');
    expect(referralErrorCode('boom', 400)).toBe('unknown');
  });
});

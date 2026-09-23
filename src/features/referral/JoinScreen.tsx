import { normaliseReferralCode, REFERRAL_CODE_PATTERN } from '@scoring';
import { useRouter, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { useSession } from '@/data/supabase/session';
import { Field } from '@/features/insights/Field';
import { clearHeldJoinArrival, isHeldJoinArrival } from '@/features/onboarding/state';
import { TripTopBar } from '@/features/trips/TopBar';
import { Banner, Button, Card, Screen, Text, useTheme } from '@/ui';

import { ReferralError, type MyReferrals } from './api';
import { referralCopy as copy, spokenCode } from './copy';
import { ReferralLoading, ReferralUnavailable, useLeave } from './InviteScreen';
import { redeemErrorLine } from './RedeemCode';
import { useRedeemReferralCode, useReferralAvailability, useReferrals, type ReferralDeps } from './useReferrals';

/** Where "Not now" and Back go when the link opened the app cold (nothing to go back to). */
const HOME = '/(tabs)/home' as Href;

/**
 * The route's `code` param as a referral code, or null. Only a single string that is a code once
 * cleaned (upper case, no spaces or hyphens) is one; anything else — a list, a path, a code with a
 * letter outside the alphabet — is not.
 */
export function parseJoinParam(param: unknown): string | null {
  if (typeof param !== 'string') return null;
  const code = normaliseReferralCode(param);
  return REFERRAL_CODE_PATTERN.test(code) ? code : null;
}

/**
 * `roadwise://join/<code>` (the one allowlist's `JOIN_HREF`, so onboarding holds and replays it).
 *
 * It never uses the code by itself: it asks "Use code … from a friend?", and only *Use code* sends
 * it. When the account can no longer use a code it says why (the first 14 days; a code already
 * used, with that code's status), and it says nothing about who sent the link. It never navigates
 * on its own either — only Back, *Not now* or *Done* leave it — so it cannot move anyone off a
 * drive (the drive lockout covers the link's arrival).
 *
 * With the referral flag off (the default) it is a plain "not available yet", and a bad link a
 * plain "isn't valid", each with Back.
 *
 * Opened by the app from a signed-out hold (M5 T12 r1, security R6), the code was never this
 * account's choice: if the account can't use a code, or invites are off, it goes Home without a
 * word. A link carrying the caller's own code is caught here, before any attempt is spent (n1).
 */
export function JoinScreen({ code: param, deps = {} }: { code: unknown; deps?: ReferralDeps }) {
  const th = useTheme();
  const leave = useLeave(HOME);
  const code = parseJoinParam(param);
  const availability = useReferralAvailability(deps);
  const referrals = useReferrals({ ...deps, enabled: code !== null });
  const redeem = useRedeemReferralCode(deps);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  // Peeked once (idempotent), cleared after mount: a later direct open of the link is not "held".
  const uid = useSession().session?.user.id ?? null;
  const [fromHold] = useState(() => code !== null && isHeldJoinArrival(uid, `/join/${code}`));
  useEffect(() => {
    if (code !== null) clearHeldJoinArrival(uid, `/join/${code}`);
  }, [code, uid]);

  const unavailable = referrals.error instanceof ReferralError && referrals.error.code === 'not_available';
  const cannotUse = referrals.data !== undefined && !referrals.data.snapshot.canRedeem;
  const dropSilently = fromHold && availability.ready && (!availability.available || unavailable || cannotUse);
  useEffect(() => {
    if (dropSilently) router.replace(HOME);
  }, [dropSilently, router]);

  if (dropSilently) {
    return (
      <Screen testID="join-screen">
        <ReferralLoading testID="join-leaving" />
      </Screen>
    );
  }

  if (code === null) {
    return (
      <Screen testID="join-screen">
        <TripTopBar title={copy.join.title} onBack={null} />
        <Text variant="body" testID="join-invalid">
          {copy.join.invalid}
        </Text>
        <View style={{ marginTop: 'auto', paddingTop: th.space.md }}>
          <Button label={copy.back} variant="secondary" onPress={leave} />
        </View>
      </Screen>
    );
  }
  if (availability.ready && (!availability.available || unavailable)) {
    return <ReferralUnavailable title={copy.join.title} onBack={leave} testID="join-screen" />;
  }

  const use = async () => {
    if (redeem.isPending) return;
    // n1: the caller's own code, known from their own snapshot, costs no attempt.
    if (referrals.data?.snapshot.code === code) {
      setError(copy.error.own_code);
      return;
    }
    setError(null);
    try {
      await redeem.mutateAsync(code);
      setSaved(true);
    } catch (e) {
      setError(redeemErrorLine(e));
    }
  };

  const data = availability.ready ? referrals.data : undefined;
  let body;
  let actions;
  if (saved) {
    body = <Banner testID="join-saved" tone="success" message={copy.redeem.saved} />;
    actions = <Button label={copy.done} onPress={leave} testID="join-done" />;
  } else if (data === undefined && referrals.isError) {
    body = (
      <Banner
        testID="join-error-load"
        tone="danger"
        message={copy.loadError}
        action={{ label: copy.retry, onPress: () => void referrals.refetch() }}
      />
    );
    actions = <Button label={copy.back} variant="secondary" onPress={leave} />;
  } else if (data === undefined) {
    body = <ReferralLoading testID="join-loading" />;
  } else if (data.snapshot.canRedeem) {
    body = (
      <Card variant="license" testID="join-card">
        <Text
          variant="title2"
          accessibilityRole="header"
          accessibilityLabel={copy.join.questionSpoken(spokenCode(code))}
          testID="join-question"
        >
          {copy.join.question(code)}
        </Text>
        <Text variant="body">{copy.join.body}</Text>
        <Text variant="subhead" tone="muted">
          {copy.invite.notMoney}
        </Text>
        {error ? (
          <Text
            testID="join-error"
            variant="callout"
            tone="danger"
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            {error}
          </Text>
        ) : null}
      </Card>
    );
    actions = (
      <>
        <Button label={copy.join.use} onPress={() => void use()} loading={redeem.isPending} testID="join-use" />
        <Button label={copy.join.notNow} variant="secondary" onPress={leave} testID="join-not-now" />
      </>
    );
  } else {
    body = <CannotUse snapshot={data.snapshot} />;
    actions = <Button label={copy.done} variant="secondary" onPress={leave} testID="join-done" />;
  }

  return (
    <Screen scroll testID="join-screen">
      <TripTopBar title={copy.join.title} onBack={null} />
      {data?.offline && !saved ? <Banner testID="join-offline" tone="info" message={copy.offline} /> : null}
      {body}
      {actions ? <View style={{ marginTop: 'auto', paddingTop: th.space.md, gap: th.space.sm }}>{actions}</View> : null}
    </Screen>
  );
}

/** Why this account can't use a code: its first 14 days are over, or it already used one. */
function CannotUse({ snapshot }: { snapshot: MyReferrals }) {
  if (snapshot.myCode === 'none') {
    return (
      <Card testID="join-closed">
        <Text variant="body">{copy.explain.windowClosed}</Text>
      </Card>
    );
  }
  return (
    <Card testID="join-used">
      <Text variant="body">{copy.explain.alreadyUsed}</Text>
      <Field label={copy.invite.myCodeLabel}>
        <Text variant="body">{copy.mine[snapshot.myCode]}</Text>
      </Field>
    </Card>
  );
}

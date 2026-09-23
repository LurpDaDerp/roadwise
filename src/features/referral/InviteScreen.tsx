import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { Share, View } from 'react-native';

import { Field } from '@/features/insights/Field';
import { TripTopBar } from '@/features/trips/TopBar';
import { Banner, Button, Card, Screen, Skeleton, Text, useTheme } from '@/ui';

import { ReferralError, type MyReferrals } from './api';
import { referralCopy as copy, shareMessage, spacedCode, spokenCode, statusLine } from './copy';
import { RedeemCode } from './RedeemCode';
import {
  useMyReferralCode,
  useReferralAvailability,
  useReferrals,
  type ReferralDeps,
} from './useReferrals';

/** F10's route (the rewards hub's link and the allowlisted `/rewards/invite`). */
export const INVITE_HREF = '/rewards/invite' as Href;
const REWARDS_TAB = '/(tabs)/rewards' as Href;

export interface InviteDeps extends ReferralDeps {
  /** The system share sheet (default React Native `Share.share`). */
  share?: (content: { message: string }) => Promise<unknown>;
}

/** Back when there is somewhere to go back to; otherwise `fallback` (a cold deep link). */
export function useLeave(fallback: Href): () => void {
  const router = useRouter();
  return () => {
    if (router.canGoBack()) router.back();
    else router.replace(fallback);
  };
}

/** The flag is off, or the server says referrals aren't available: a plain line and Back. */
export function ReferralUnavailable({ title, onBack, testID }: { title: string; onBack: () => void; testID: string }) {
  const th = useTheme();
  return (
    <Screen testID={testID}>
      {/* One Back, at the bottom: the header's would be a second control doing the same thing. */}
      <TripTopBar title={title} onBack={null} />
      <Text variant="body" testID="referral-unavailable">
        {copy.unavailable}
      </Text>
      <View style={{ marginTop: 'auto', paddingTop: th.space.md }}>
        <Button label={copy.back} variant="secondary" onPress={onBack} testID="referral-unavailable-back" />
      </View>
    </Screen>
  );
}

/** A card that has not been printed yet: one element that says it is loading. */
export function ReferralLoading({ testID }: { testID: string }) {
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={copy.loading} testID={testID}>
      <Card variant="license">
        <Skeleton width="30%" height={14} />
        <Skeleton width="70%" height={46} />
        <Skeleton width="50%" height={20} />
      </Card>
    </View>
  );
}

const isUnavailable = (error: unknown) => error instanceof ReferralError && error.code === 'not_available';

/**
 * F10 · Invite friends. The driver's code, printed large in the licence's numeral face and read
 * aloud one character at a time; what an invite earns, that points aren't money, and the yearly
 * limit; how many friends joined and counted (counts only: never a name, id or date); the friend's
 * own code status, or the field to use one while that is still possible; and *Share invite*, the
 * screen's one primary action, which opens the system share sheet with the code and links.
 *
 * With the referral flag off (the default) the whole screen is a plain "not available yet".
 */
export function InviteScreen({ deps = {} }: { deps?: InviteDeps }) {
  const th = useTheme();
  const leave = useLeave(REWARDS_TAB);
  const availability = useReferralAvailability(deps);
  const referrals = useReferrals(deps);
  const myCode = useMyReferralCode(deps);
  const [saved, setSaved] = useState(false);

  if (availability.ready && (!availability.available || isUnavailable(referrals.error))) {
    return <ReferralUnavailable title={copy.invite.title} onBack={leave} testID="invite-screen" />;
  }
  // Until the config is read nothing is claimed either way: no Share button that may vanish.
  if (!availability.ready) {
    return (
      <Screen testID="invite-screen">
        <TripTopBar title={copy.invite.title} onBack={leave} />
        <ReferralLoading testID="invite-loading" />
      </Screen>
    );
  }

  const data = referrals.data;
  const code = myCode.data ?? data?.snapshot.code ?? null;
  const share = async () => {
    if (code === null) return;
    try {
      await (deps.share ?? ((content) => Share.share(content)))({ message: shareMessage(code, availability.storeUrl) });
    } catch {
      // Dismissed or unavailable: nothing was sent, and there is nothing to say about it.
    }
  };

  let body;
  if (data === undefined && referrals.isError) {
    body = (
      <Banner
        testID="invite-error"
        tone="danger"
        message={copy.loadError}
        action={{ label: copy.retry, onPress: () => void referrals.refetch() }}
      />
    );
  } else if (data === undefined) {
    body = <ReferralLoading testID="invite-loading" />;
  } else {
    body = (
      <>
        <Card variant="license" testID="invite-card">
          <CodeField code={code} failed={code === null && myCode.isError} onRetry={() => void myCode.refetch()} />
          <StatusField snapshot={data.snapshot} />
        </Card>
        <View style={{ gap: th.space.sm }}>
          <Text variant="body">{copy.invite.explainer}</Text>
          <Text variant="subhead" tone="muted">
            {copy.invite.notMoney}
          </Text>
          <Text variant="subhead" tone="muted">
            {copy.invite.yearly}
          </Text>
        </View>
        <FriendCode snapshot={data.snapshot} saved={saved} onSaved={() => setSaved(true)} deps={deps} />
      </>
    );
  }

  return (
    <Screen scroll testID="invite-screen">
      <TripTopBar title={copy.invite.title} onBack={leave} />
      {data?.offline ? <Banner testID="invite-offline" tone="info" message={copy.offline} /> : null}
      {body}
      <View style={{ marginTop: 'auto', paddingTop: th.space.md }}>
        <Button
          label={copy.invite.share}
          onPress={() => void share()}
          disabled={code === null}
          accessibilityHint={copy.invite.shareHint}
          testID="invite-share"
        />
      </View>
    </Screen>
  );
}

function CodeField({ code, failed, onRetry }: { code: string | null; failed: boolean; onRetry: () => void }) {
  const th = useTheme();
  return (
    <Field label={copy.invite.codeLabel}>
      {code !== null ? (
        // One element, spoken character by character: "ABCD" must never be read as a word.
        <View accessible accessibilityRole="text" accessibilityLabel={copy.invite.codeSpoken(spokenCode(code))} testID="invite-code">
          <Text variant="display" selectable style={{ letterSpacing: 2 }}>
            {spacedCode(code)}
          </Text>
        </View>
      ) : failed ? (
        <View style={{ gap: th.space.sm, alignItems: 'flex-start' }}>
          <Text variant="body">{copy.invite.codeError}</Text>
          <Button label={copy.retry} variant="ghost" size="md" onPress={onRetry} />
        </View>
      ) : (
        <Skeleton width="70%" height={46} />
      )}
    </Field>
  );
}

function StatusField({ snapshot }: { snapshot: MyReferrals }) {
  const th = useTheme();
  const line = statusLine(snapshot);
  const capped = snapshot.cap > 0 && snapshot.rewardedThisYear >= snapshot.cap;
  return (
    <Field label={copy.invite.statusLabel}>
      <View style={{ gap: th.space.xs }}>
        <View
          accessible
          accessibilityRole="text"
          accessibilityLabel={`${copy.invite.statusLabel}: ${line.spoken}`}
          testID="invite-status"
        >
          <Text variant="title3">{line.text}</Text>
        </View>
        {capped ? <Text variant="subhead">{copy.invite.cap}</Text> : null}
      </View>
    </Field>
  );
}

/** The friend's-code section: just saved, the field while it can be used, or the code's status. */
function FriendCode({
  snapshot,
  saved,
  onSaved,
  deps,
}: {
  snapshot: MyReferrals;
  saved: boolean;
  onSaved: () => void;
  deps: InviteDeps;
}) {
  const th = useTheme();
  if (saved) return <Banner testID="invite-saved" tone="success" message={copy.redeem.saved} />;
  if (snapshot.canRedeem) {
    return (
      <View style={{ gap: th.space.sm, paddingTop: th.space.sm }}>
        <Text variant="headline" accessibilityRole="header">
          {copy.invite.gotCode}
        </Text>
        <RedeemCode deps={deps} onSaved={onSaved} ownCode={snapshot.code} />
      </View>
    );
  }
  if (snapshot.myCode === 'none') return null;
  return (
    <Card testID="invite-my-code">
      <Field label={copy.invite.myCodeLabel}>
        <Text variant="body">{copy.mine[snapshot.myCode]}</Text>
      </Field>
    </Card>
  );
}

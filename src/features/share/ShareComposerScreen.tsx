import { useRouter, type Href } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, Switch, useWindowDimensions, View } from 'react-native';
import type Svg from 'react-native-svg';

import { useTrip } from '@/data/queries';
import { TripTopBar } from '@/features/trips/TopBar';
import { useRewards } from '@/features/rewards/useRewards';
import type { RewardsApi } from '@/features/rewards/api';
import { useMyReferralCode, useReferralAvailability, type ReferralDeps } from '@/features/referral/useReferrals';
import { Banner, Button, Card, Screen, Skeleton, Text, useTheme } from '@/ui';

import {
  buildCardModel,
  captionFor,
  DEFAULT_TOGGLES,
  isCardKind,
  type CardInput,
  type CardKind,
  type CardToggles,
} from './cardModel';
import { shareCopy as copy } from './copy';
import { shareCard, type ShareDeps, type SvgSnapshot } from './shareAdapter';
import { ShareCardSvg } from './ShareCardSvg';

const REWARDS_HREF = '/rewards' as Href;

export interface ShareComposerDeps extends ReferralDeps {
  rewardsApi?: RewardsApi;
  share?: ShareDeps;
}

/** The route's params, as Expo Router hands them over (each may be a string, a list or absent). */
export interface ShareParams {
  kind?: unknown;
  clientTripId?: unknown;
  badgeId?: unknown;
}

const single = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;

/**
 * F9 · the share composer (a sheet over the screen that opened it). One card — a confirmed
 * drive, the safe-day streak, an earned badge, the class, or a reached weekly goal — previewed
 * live, with *Show distance* (drives only) and *Add my invite code* (only while invites are on),
 * both off by default for everyone (R-E, D10), and one primary *Share*.
 *
 * The preview is the real card: the same SVG the share renders, scaled to the sheet. It is one
 * image to a screen reader, labelled with the caption (the card in words). Under it, always:
 * "No map, place or time is ever shown."
 */
export function ShareComposerScreen({ params, deps = {} }: { params: ShareParams; deps?: ShareComposerDeps }) {
  const kind = isCardKind(params.kind) ? params.kind : null;
  const clientTripId = single(params.clientTripId);
  const badgeId = single(params.badgeId);

  if (kind === null || (kind === 'trip' && clientTripId === null) || (kind === 'badge' && badgeId === null)) {
    return <NothingToShare />;
  }
  if (kind === 'trip') return <TripComposer clientTripId={clientTripId as string} deps={deps} />;
  return <RewardsComposer kind={kind} badgeId={badgeId} deps={deps} />;
}

function useClose(): () => void {
  const router = useRouter();
  return () => {
    if (router.canGoBack()) router.back();
    else router.replace(REWARDS_HREF);
  };
}

function Frame({ children, onClose }: { children: React.ReactNode; onClose: (() => void) | null }) {
  return (
    <Screen scroll testID="share-screen">
      <TripTopBar title={copy.title} onBack={onClose} />
      {children}
    </Screen>
  );
}

function NothingToShare() {
  const th = useTheme();
  const router = useRouter();
  return (
    <Frame onClose={null}>
      <Text variant="body" testID="share-nothing">
        {copy.nothing.title}
      </Text>
      <View style={{ marginTop: 'auto', paddingTop: th.space.md }}>
        <Button label={copy.nothing.action} variant="secondary" onPress={() => router.replace(REWARDS_HREF)} />
      </View>
    </Frame>
  );
}

function Loading({ onClose }: { onClose: () => void }) {
  return (
    <Frame onClose={onClose}>
      <View accessible accessibilityRole="progressbar" accessibilityLabel={copy.loading} testID="share-loading">
        <Card variant="license">
          <Skeleton width="40%" height={16} />
          <Skeleton width="100%" height={280} />
        </Card>
      </View>
    </Frame>
  );
}

function LoadError({ onClose, onRetry }: { onClose: () => void; onRetry: () => void }) {
  return (
    <Frame onClose={onClose}>
      <Banner testID="share-load-error" tone="danger" message={copy.loadError} action={{ label: copy.retry, onPress: onRetry }} />
    </Frame>
  );
}

function TripComposer({ clientTripId, deps }: { clientTripId: string; deps: ShareComposerDeps }) {
  const close = useClose();
  const trip = useTrip(clientTripId);
  if (trip.isPending) return <Loading onClose={close} />;
  if (trip.isError) return <LoadError onClose={close} onRetry={() => void trip.refetch()} />;
  return <Composer input={{ kind: 'trip', trip: trip.data?.trip ?? null }} offline={false} deps={deps} onClose={close} />;
}

function RewardsComposer({
  kind,
  badgeId,
  deps,
}: {
  kind: Exclude<CardKind, 'trip'>;
  badgeId: string | null;
  deps: ShareComposerDeps;
}) {
  const close = useClose();
  const rewards = useRewards({ api: deps.rewardsApi, appState: deps.appState });
  const data = rewards.data;
  if (data === undefined && rewards.isError) return <LoadError onClose={close} onRetry={() => void rewards.refetch()} />;
  if (data === undefined) return <Loading onClose={close} />;
  const snap = data.snapshot;
  const input: CardInput =
    kind === 'badge'
      ? { kind, badgeId: badgeId ?? '', badges: snap.badges, defs: snap.badgeDefs }
      : kind === 'goal'
        ? { kind, goals: [snap.currentGoal, snap.lastGoal] }
        : { kind, progress: snap.progress };
  return <Composer input={input} offline={data.offline} deps={deps} onClose={close} />;
}

function Composer({
  input,
  offline,
  deps,
  onClose,
}: {
  input: CardInput;
  offline: boolean;
  deps: ShareComposerDeps;
  onClose: () => void;
}) {
  const th = useTheme();
  const { width } = useWindowDimensions();
  const [toggles, setToggles] = useState<CardToggles>(DEFAULT_TOGGLES);
  const [sharing, setSharing] = useState(false);
  const [failed, setFailed] = useState(false);
  const svgRef = useRef<Svg>(null);
  const availability = useReferralAvailability(deps);
  // The code is asked for only once the driver turns it on (R-E; T12 carry).
  const code = useMyReferralCode({ ...deps, enabled: toggles.code });

  const model = buildCardModel({ ...input, inviteCode: toggles.code ? (code.data ?? null) : null }, toggles);
  if (model === null) {
    return (
      <Frame onClose={onClose}>
        <Text variant="body" testID="share-empty">
          {copy.empty[input.kind]}
        </Text>
        <View style={{ marginTop: 'auto', paddingTop: th.space.md }}>
          <Button label={copy.close} variant="secondary" onPress={onClose} />
        </View>
      </Frame>
    );
  }

  const caption = captionFor(model);
  const previewWidth = Math.min(width - 2 * th.space.lg, 420);
  const share = async () => {
    if (sharing) return;
    setSharing(true);
    setFailed(false);
    const outcome = await shareCard(svgRef.current as unknown as SvgSnapshot | null, model, deps.share);
    setSharing(false);
    if (outcome === 'failed') setFailed(true);
  };

  return (
    <Frame onClose={onClose}>
      {offline ? <Banner testID="share-offline" tone="info" message={copy.offline} /> : null}
      <View style={{ alignItems: 'center', gap: th.space.sm }}>
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={caption}
          testID="share-preview"
          style={{
            borderRadius: th.radius.lg,
            overflow: 'hidden',
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: th.colors.border,
          }}
        >
          <ShareCardSvg ref={svgRef} model={model} width={previewWidth} testID="share-card" />
        </View>
        <Text variant="footnote" tone="muted" style={{ textAlign: 'center' }}>
          {copy.privacyLine}
        </Text>
      </View>

      <View style={{ gap: th.space.xs }}>
        {input.kind === 'trip' ? (
          <ToggleRow
            title={copy.toggles.distance}
            hint={copy.toggles.distanceHint}
            value={toggles.distance}
            onChange={(distance) => setToggles((t) => ({ ...t, distance }))}
            testID="toggle-distance"
          />
        ) : null}
        {availability.available ? (
          <ToggleRow
            title={copy.toggles.code}
            hint={copy.toggles.codeHint}
            value={toggles.code}
            onChange={(on) => setToggles((t) => ({ ...t, code: on }))}
            testID="toggle-code"
            note={
              toggles.code && code.isError
                ? copy.toggles.codeError
                : toggles.code && code.isPending
                  ? copy.toggles.codeLoading
                  : null
            }
          />
        ) : null}
      </View>

      {failed ? (
        <Banner
          testID="share-failed"
          tone="danger"
          message={copy.failed}
          action={{ label: copy.retry, onPress: () => void share() }}
        />
      ) : null}

      <View style={{ marginTop: 'auto', paddingTop: th.space.md }}>
        <Button
          label={copy.share}
          onPress={() => void share()}
          loading={sharing}
          accessibilityHint={copy.shareHint}
          testID="share-button"
        />
      </View>
    </Frame>
  );
}

function ToggleRow({
  title,
  hint,
  value,
  onChange,
  note,
  testID,
}: {
  title: string;
  hint: string;
  value: boolean;
  onChange: (value: boolean) => void;
  note?: string | null;
  testID: string;
}) {
  const th = useTheme();
  return (
    <View style={{ gap: th.space.xs, paddingVertical: th.space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.md, minHeight: 44 }}>
        <Text variant="body" style={{ flex: 1 }}>
          {title}
        </Text>
        <Switch
          testID={testID}
          accessibilityRole="switch"
          accessibilityLabel={title}
          accessibilityHint={hint}
          accessibilityState={{ checked: value }}
          value={value}
          onValueChange={onChange}
          trackColor={{ true: th.colors.accent, false: th.colors.border }}
        />
      </View>
      {note ? (
        <Text variant="footnote" tone="muted" accessibilityLiveRegion="polite">
          {note}
        </Text>
      ) : null}
    </View>
  );
}

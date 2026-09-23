import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useScoreDaily, useTrip, useTripEvents } from '@/data/queries';
import { Banner, Button, Card, EmptyState, Screen, Skeleton, Text, useTheme } from '@/ui';

import { tripCopy as copy } from './copy';
import { DayEarnedField } from './EarnedField';
import { highlightsFor, isPerfect } from './format';
import { RoleChips } from './RoleChips';
import { HOME_HREF, tripDetailHref, tripEventsHref, tripTipHref } from './routes';
import { tipForTrip } from './tip';
import { TipCard } from './TipCard';
import { TripTopBar } from './TopBar';
import { TripHeader } from './TripHeader';
import { TripHighlights } from './TripHighlights';
import { TripScoreField } from './TripScoreField';

/** §7.0: plain words first; the server's code only under "Details", for support. */
function SyncErrorNotice({ code }: { code: string | null }) {
  const [open, setOpen] = useState(false);
  const th = useTheme();
  return (
    <View style={{ gap: th.space.sm }} testID="sync-error">
      <Banner
        tone="warning"
        message={copy.syncError.message}
        action={
          code === null
            ? undefined
            : { label: open ? copy.syncError.hide : copy.syncError.details, onPress: () => setOpen((v) => !v) }
        }
      />
      {open && code !== null ? (
        <Text variant="footnote" tone="muted" selectable>
          {copy.syncError.code(code)}
        </Text>
      ) : null}
    </View>
  );
}

/** The card's shape while the row is read: the same fields, unprinted. Never a spinner. */
function SummarySkeleton() {
  const th = useTheme();
  return (
    <Card variant="license" testID="summary-skeleton">
      <Skeleton width="70%" height={28} />
      <Skeleton width="50%" height={16} />
      <View style={{ flexDirection: 'row', gap: th.space.lg }}>
        <Skeleton width={72} height={40} />
        <Skeleton width={72} height={40} />
        <Skeleton width={72} height={40} />
      </View>
      <View style={{ alignItems: 'center', paddingVertical: th.space.md }}>
        <Skeleton width={160} height={160} radius={80} />
      </View>
    </Card>
  );
}

/**
 * F9's composer for this drive (Task 13 builds the route; the plan fixes its interface:
 * `/rewards/share?kind=trip&clientTripId=<id>`). Not yet in Expo Router's generated union until
 * that file exists, hence the one cast.
 */
export const tripShareHref = (clientTripId: string): Href =>
  `/rewards/share?kind=trip&clientTripId=${encodeURIComponent(clientTripId)}` as Href;

function FooterLinks({
  onFullTrip,
  onSomethingWrong,
  onShare,
}: {
  onFullTrip: () => void;
  onSomethingWrong: () => void;
  /** Null until the drive is confirmed (synced, final): there is nothing true to share before. */
  onShare: (() => void) | null;
}) {
  const th = useTheme();
  return (
    <View style={{ gap: th.space.xs }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.sm }}>
        <Button label={copy.footer.fullTrip} variant="ghost" size="md" onPress={onFullTrip} />
        <Button label={copy.footer.wrong} variant="ghost" size="md" onPress={onSomethingWrong} />
        <Button
          label={copy.footer.share}
          variant="ghost"
          size="md"
          onPress={onShare ?? (() => {})}
          disabled={onShare === null}
          accessibilityHint={onShare === null ? copy.footer.shareUnconfirmed : undefined}
          testID="share"
        />
      </View>
      {onShare === null ? (
        <Text variant="footnote" tone="subtle">
          {copy.footer.shareUnconfirmed}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * D1 — the card back (§7.D D1): the ten-second debrief. The licence card carries the route, the
 * splits and the score; under it the three highlights, the one tip, what the day has earned,
 * and the links to the rest of the trip. One primary action, Done, bottom-anchored.
 */
export function TripSummaryScreen({ clientTripId }: { clientTripId: string }) {
  const router = useRouter();
  const th = useTheme();
  const detailQuery = useTrip(clientTripId);
  const eventsQuery = useTripEvents(clientTripId);
  // Only once the trip is known, so no cache entry is minted for a day nothing has (M-12).
  const day = detailQuery.data?.trip.day ?? null;
  const dayQuery = useScoreDaily(day === null ? null : { from: day, to: day });

  const done = () => router.dismissTo(HOME_HREF);
  const back = router.canGoBack() ? () => router.back() : null;

  // The timeline is waited for too: the episode count on the costly highlight and the severity
  // the tip is chosen at both come from it, and a tip that changes under the reader is worse
  // than a card that arrives whole. Both are local SQLite reads on the same file.
  if (detailQuery.isPending || eventsQuery.isPending) {
    return (
      <Screen scroll>
        <TripTopBar title={copy.summaryTitle} onBack={back} />
        <View accessibilityLabel={copy.loading} accessibilityRole="progressbar" accessible>
          <SummarySkeleton />
        </View>
      </Screen>
    );
  }

  // The timeline is not optional decoration: the episode count on the costly highlight and the
  // severity the tip is chosen at both come from it, so a failed events read must not render a
  // quietly different card (Task 6 review, I-1). Both reads are retried together.
  if (detailQuery.error || eventsQuery.error) {
    return (
      <Screen>
        <TripTopBar title={copy.summaryTitle} onBack={back} />
        <Banner
          tone="danger"
          message={copy.error.message}
          action={{
            label: copy.error.retry,
            onPress: () => {
              void detailQuery.refetch();
              void eventsQuery.refetch();
            },
          }}
        />
        <View style={{ flexGrow: 1 }} />
        <Button label={copy.done} onPress={done} />
      </Screen>
    );
  }

  const detail = detailQuery.data;
  if (!detail) {
    return (
      <Screen>
        <TripTopBar title={copy.summaryTitle} onBack={back} />
        <EmptyState title={copy.notFound.title} body={copy.notFound.body} />
        <View style={{ flexGrow: 1 }} />
        <Button label={copy.done} onPress={done} />
      </Screen>
    );
  }

  const { trip, unscoredReason } = detail;
  const events = eventsQuery.data ?? [];
  const highlights = highlightsFor(trip, events);
  const { tip } = tipForTrip(detail, events);
  const perfect = isPerfect(trip);
  const shareable = trip.syncState === 'synced' && trip.status === 'final';

  return (
    <Screen scroll testID="trip-summary">
      <TripTopBar title={copy.summaryTitle} onBack={back} />
      {trip.syncState === 'failed' ? <SyncErrorNotice code={trip.syncError} /> : null}

      <Card variant="license" testID="card-back">
        <TripHeader trip={trip} />
        <TripScoreField trip={trip} unscoredReason={unscoredReason} perfect={perfect} />
        {trip.incomplete ? (
          <Text variant="footnote" tone="muted" testID="recovered-note">
            {copy.recovered}
          </Text>
        ) : null}
      </Card>

      {trip.role === 'unknown' ? <RoleChips clientTripId={clientTripId} testID="role-chips" /> : null}
      {highlights.length > 0 ? <TripHighlights highlights={highlights} /> : null}
      {tip ? (
        <TipCard tip={tip} onPress={() => router.push(tripTipHref(clientTripId))} testID="tip-card" />
      ) : null}
      {trip.scored ? <DayEarnedField trip={trip} day={dayQuery.data?.[0] ?? null} /> : null}

      <FooterLinks
        onFullTrip={() => router.push(tripDetailHref(clientTripId))}
        onSomethingWrong={() => router.push(tripEventsHref(clientTripId))}
        onShare={shareable ? () => router.push(tripShareHref(clientTripId)) : null}
      />

      <View style={{ flexGrow: 1, minHeight: th.space.lg }} />
      <Button label={copy.done} onPress={done} testID="done" />
    </Screen>
  );
}

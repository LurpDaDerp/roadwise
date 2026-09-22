import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { categoryCaps } from '@/content/scoring-explainer';
import { useOnline } from '@/data/net/useOnline';
import {
  useTrip,
  useTripEvents,
  type TripSummary,
  type UnscoredReason,
} from '@/data/queries';
import { Banner, Button, Card, EmptyState, Screen, Skeleton, Text, useTheme } from '@/ui';
import { bandLabel, CategoryBars, formatScore } from '@/ui/charts';

import { tripCopy as copy } from './copy';
import { routeFor, timelineRows } from './detail';
import { Field, FieldText } from './Field';
import { unscoredCopy } from './format';
import { TripTopBar } from './TopBar';
import { TripConditionsField, TripQualityField } from './TripFacts';
import { TripHeader } from './TripHeader';
import { TripRouteField } from './TripMap';
import { TripTimeline } from './TripTimeline';
import { HOME_HREF, tripEditHref, tripEventHref } from './routes';

function DetailSkeleton() {
  const th = useTheme();
  return (
    <Card variant="license" testID="detail-skeleton">
      <Skeleton width="70%" height={28} />
      <Skeleton width="50%" height={16} />
      <Skeleton width="100%" height={180} />
      <Skeleton width="90%" height={20} />
      <Skeleton width="80%" height={20} />
      <View style={{ height: th.space.xs }} />
    </Card>
  );
}

/** The score as a printed field rather than a second ring: D1 already drew the ring. */
function ScoreLine({
  trip,
  unscoredReason,
}: {
  trip: TripSummary;
  unscoredReason: UnscoredReason | null;
}) {
  const th = useTheme();
  if (trip.scored && trip.score !== null && trip.band !== null) {
    return (
      <Field label={copy.score.label}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: th.space.md }}>
          <FieldText face="numeral" variant="display" testID="detail-score">
            {formatScore(trip.score)}
          </FieldText>
          <FieldText variant="title3" tone="muted">
            {bandLabel(trip.band)}
          </FieldText>
        </View>
      </Field>
    );
  }
  const words = unscoredCopy(trip, unscoredReason);
  return (
    <Field label={copy.score.label}>
      <FieldText variant="title2">{words.title}</FieldText>
      <Text variant="subhead" tone="muted">
        {words.body}
      </Text>
    </Field>
  );
}

/**
 * D2 — the whole drive (§7.D D2): where the score changed, and why.
 *
 * The order on screen is the order of trust. The card header says which drive this is; the route
 * is a **collapsible** picture of it; the **timeline** underneath is the real account, one row
 * per moment with its measurement, its confidence and its cost, and it is what a screen reader
 * is given — the map is hidden from assistive technology and can be absent entirely without the
 * screen losing anything (§7.D D2 a11y: "Map is never the only way to read the trip"). Below
 * that, the arithmetic: points lost per category against its cap, the conditions the drive
 * happened in, and how good the data behind all of it was.
 */
export function TripDetailScreen({ clientTripId }: { clientTripId: string }) {
  const router = useRouter();
  const th = useTheme();
  const detailQuery = useTrip(clientTripId);
  const eventsQuery = useTripEvents(clientTripId);
  // Read here, above every early return, so the hook order never changes between renders.
  const online = useOnline();

  const back = () => (router.canGoBack() ? router.back() : router.dismissTo(HOME_HREF));

  if (detailQuery.isPending || eventsQuery.isPending) {
    return (
      <Screen scroll>
        <TripTopBar title={copy.detail.title} onBack={back} />
        <View accessibilityLabel={copy.loading} accessibilityRole="progressbar" accessible>
          <DetailSkeleton />
        </View>
      </Screen>
    );
  }

  // The timeline is this screen's subject, not a decoration: a failed events read is the screen
  // failing, and both reads are retried together.
  if (detailQuery.error || eventsQuery.error) {
    return (
      <Screen>
        <TripTopBar title={copy.detail.title} onBack={back} />
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
      </Screen>
    );
  }

  const detail = detailQuery.data;
  if (!detail) {
    return (
      <Screen>
        <TripTopBar title={copy.detail.title} onBack={back} />
        <EmptyState title={copy.notFound.title} body={copy.notFound.body} />
      </Screen>
    );
  }

  const { trip, unscoredReason } = detail;
  const events = eventsQuery.data ?? [];
  const rows = timelineRows(trip, events);
  const route = routeFor(trip);

  return (
    <Screen scroll testID="trip-detail">
      <TripTopBar title={copy.detail.title} onBack={back} />

      <Card variant="license" testID="detail-card">
        <TripHeader trip={trip} />
        <ScoreLine trip={trip} unscoredReason={unscoredReason} />
      </Card>

      <TripRouteField
        points={route}
        events={events}
        hasRoute={trip.polyline !== null && trip.polyline.length > 0}
        online={online}
        testID="route-field"
      />

      {rows.length > 0 ? (
        <TripTimeline
          rows={rows}
          onOpen={(eventId) => router.push(tripEventHref(clientTripId, eventId))}
          testID="timeline"
        />
      ) : (
        <EmptyState
          title={copy.detail.cleanTitle}
          body={copy.detail.cleanBody}
          testID="clean-drive"
        />
      )}

      {trip.scored ? (
        <Field label={copy.detail.categoriesLabel}>
          <CategoryBars
            deductions={trip.categoryDeductions}
            caps={categoryCaps}
            testID="category-bars"
          />
        </Field>
      ) : (
        <Text variant="footnote" tone="muted" testID="unscored-note">
          {copy.detail.unscoredNote}
        </Text>
      )}

      <TripConditionsField trip={trip} testID="conditions" />
      <TripQualityField trip={trip} testID="quality" />

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.sm }}>
        <Button
          label={copy.detail.edit}
          variant="ghost"
          size="md"
          onPress={() => router.push(tripEditHref(clientTripId))}
          testID="edit-trip"
        />
        <Button
          label={copy.footer.share}
          variant="ghost"
          size="md"
          onPress={() => {}}
          disabled
          accessibilityHint={copy.footer.shareSoon}
        />
      </View>
      <Text variant="footnote" tone="subtle">
        {copy.footer.shareSoon}
      </Text>
    </Screen>
  );
}

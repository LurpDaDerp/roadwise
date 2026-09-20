import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { useTrip, useTripEvents } from '@/data/queries';
import { Banner, EmptyState, Screen, Skeleton, Text } from '@/ui';

import { tripCopy as copy } from './copy';
import { timelineRows } from './detail';
import { HOME_HREF, tripEventHref } from './routes';
import { TripTopBar } from './TopBar';
import { TripTimeline } from './TripTimeline';

/**
 * D3's entry from "Something wrong?" (§7.D D1 footer): the drive's moments, to pick one from.
 *
 * It is the same timeline D2 prints, under a heading that says what tapping a row is for — one
 * list, one set of words, one place the standings are decided. A drive with nothing flagged says
 * so rather than showing an empty list.
 */
export function EventListScreen({ clientTripId }: { clientTripId: string }) {
  const router = useRouter();
  const detailQuery = useTrip(clientTripId);
  const eventsQuery = useTripEvents(clientTripId);

  const back = () => (router.canGoBack() ? router.back() : router.dismissTo(HOME_HREF));

  if (detailQuery.isPending || eventsQuery.isPending) {
    return (
      <Screen scroll>
        <TripTopBar title={copy.events.title} onBack={back} />
        <View accessibilityLabel={copy.loading} accessibilityRole="progressbar" accessible>
          <Skeleton width="90%" height={20} />
          <Skeleton width="100%" height={72} />
          <Skeleton width="100%" height={72} />
        </View>
      </Screen>
    );
  }

  if (detailQuery.error || eventsQuery.error) {
    return (
      <Screen>
        <TripTopBar title={copy.events.title} onBack={back} />
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
        <TripTopBar title={copy.events.title} onBack={back} />
        <EmptyState title={copy.notFound.title} body={copy.notFound.body} />
      </Screen>
    );
  }

  const events = eventsQuery.data ?? [];
  const rows = timelineRows(detail.trip, events);

  return (
    <Screen scroll testID="event-list">
      <TripTopBar title={copy.events.title} onBack={back} />
      {rows.length === 0 ? (
        <EmptyState
          title={copy.events.emptyTitle}
          body={copy.events.emptyBody}
          testID="no-events"
        />
      ) : (
        <>
          <Text variant="subhead" tone="muted">
            {copy.events.intro}
          </Text>
          <TripTimeline
            rows={rows}
            onOpen={(eventId) => router.push(tripEventHref(clientTripId, eventId))}
            testID="event-timeline"
          />
        </>
      )}
    </Screen>
  );
}

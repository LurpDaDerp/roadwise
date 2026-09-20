import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useTrip, useTripEvents, type TripEventView } from '@/data/queries';
import { Banner, Button, Card, EmptyState, Screen, Skeleton, Text, useTheme } from '@/ui';
import { formatPoints } from '@/ui/charts';

import { tripCopy as copy } from './copy';
import {
  canReport,
  confidenceLevel,
  confidenceReasons,
  eventStanding,
  measuredLine,
  severityWord,
  whyItMatters,
} from './detail';
import { DisputeSheet } from './DisputeSheet';
import { Field, FieldText } from './Field';
import { categoryLabel, dateLine, formatClock } from './format';
import { TIGHT } from './layout';
import { HOME_HREF, tripEditHref } from './routes';
import { TripTopBar } from './TopBar';
import { EventMiniMap } from './TripMap';
import { STANDING_WHY } from './TripTimeline';
import { useReportEvent, type DisputeInput } from './tripActions';

/** The standing, said out loud, with the sentence that makes it fair. */
function StandingNotice({ event, testID }: { event: TripEventView; testID?: string }) {
  const th = useTheme();
  const standing = eventStanding(event);
  const why = STANDING_WHY[standing];
  const label = {
    counted: null,
    possible: copy.standing.possible,
    reportSending: copy.standing.reportSending,
    reportAccepted: copy.standing.reportAccepted,
    reportRecorded: copy.standing.reportRecorded,
    reportClosed: copy.standing.reportClosed,
    removed: copy.standing.removed,
    free: null,
  }[standing];
  if (label === null) return null;

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel={why === null ? label : `${label}. ${why}`}
      style={{
        gap: TIGHT,
        padding: th.space.md,
        borderRadius: th.radius.md,
        borderWidth: 1,
        borderColor: th.colors.border,
        backgroundColor: th.colors.surfaceRaised,
      }}
    >
      <Text variant="headline">{label}</Text>
      {why !== null ? (
        <Text variant="subhead" tone="muted">
          {why}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * D3 — one moment, and the report (§7.D D3).
 *
 * The screen answers three questions in order, because that is the order a driver who thinks the
 * app got it wrong asks them: *what did you measure* (the numbers, in mph and seconds and g),
 * *how sure are you* (the confidence, and the sensors it came from), *what did it cost*. Only
 * then, **This isn't right** — two taps to a report, as §7.D D3 requires.
 *
 * Nothing here judges the report. §9.9's allowance is counted on the server; this screen says
 * the report is saved, and shows the server's own answer when it arrives — including the honest
 * one, that the report was recorded and did not change the score.
 */
export function EventDetailScreen({
  clientTripId,
  eventId,
}: {
  clientTripId: string;
  eventId: string;
}) {
  const router = useRouter();
  const th = useTheme();
  const detailQuery = useTrip(clientTripId);
  const eventsQuery = useTripEvents(clientTripId);
  const { report, phase } = useReportEvent(clientTripId);
  const [sheet, setSheet] = useState(false);

  const back = () => (router.canGoBack() ? router.back() : router.dismissTo(HOME_HREF));

  if (detailQuery.isPending || eventsQuery.isPending) {
    return (
      <Screen scroll>
        <TripTopBar title={copy.event.title} onBack={back} />
        <View accessibilityLabel={copy.loading} accessibilityRole="progressbar" accessible>
          <Skeleton width="60%" height={24} />
          <Skeleton width="100%" height={160} />
          <Skeleton width="80%" height={20} />
        </View>
      </Screen>
    );
  }

  if (detailQuery.error || eventsQuery.error) {
    return (
      <Screen>
        <TripTopBar title={copy.event.title} onBack={back} />
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
  const event = (eventsQuery.data ?? []).find((row) => row.id === eventId);
  if (!detail || !event) {
    return (
      <Screen>
        <TripTopBar title={copy.event.title} onBack={back} />
        <EmptyState title={copy.event.notFound} body={copy.event.notFoundBody} />
      </Screen>
    );
  }

  const { trip } = detail;
  const title = event.category === null ? event.rawCategory : categoryLabel(event.category);
  const severity = severityWord(event);
  const confidence = confidenceLevel(event);
  const reasons = confidenceReasons(event);
  const why = whyItMatters(event.category);
  // What the moment costs is read from the row, not from the standing: a report that was
  // recorded but not applied (§9.9) leaves the points exactly where they were.
  const counted = event.affectsScore;

  const submit = (input: DisputeInput) => {
    void report(event.id, input).then((ok) => {
      if (ok) setSheet(false);
    });
  };

  return (
    <Screen scroll testID="event-detail">
      <TripTopBar title={title} onBack={back} />

      <Card variant="license" testID="event-card">
        <Field label={copy.event.whenLabel}>
          <FieldText face="numeral" variant="title2">
            {formatClock(event.startedAt, trip.tz)}
          </FieldText>
          <Text variant="footnote" tone="muted">
            {dateLine(trip)}
          </Text>
        </Field>

        <EventMiniMap event={event} testID="event-map" />

        <Field label={copy.event.whatLabel}>
          <FieldText variant="title3" testID="measured">
            {measuredLine(event)}
          </FieldText>
          {severity !== 'none' ? (
            <Text variant="subhead" tone="muted">
              {copy.severity[severity]}
            </Text>
          ) : null}
        </Field>

        <Field label={copy.event.confidenceLabel}>
          <FieldText variant="body">{copy.confidence[confidence]}</FieldText>
          {reasons.length > 0 ? (
            <Text variant="footnote" tone="muted" testID="confidence-reasons">
              {reasons.join(' · ')}
            </Text>
          ) : null}
        </Field>

        <Field label={copy.event.pointsLabel}>
          <FieldText face="numeral" variant="title2" testID="event-points">
            {counted && event.deduction > 0
              ? copy.event.pointsLost(formatPoints(event.deduction))
              : copy.event.pointsNone}
          </FieldText>
        </Field>
      </Card>

      <StandingNotice event={event} testID="standing" />

      {why !== null ? (
        <Field label={copy.event.whyLabel}>
          <Text variant="subhead" tone="muted">
            {why}
          </Text>
        </Field>
      ) : null}

      {phase === 'done' ? (
        <Banner tone="success" message={copy.dispute.queued} testID="report-saved" />
      ) : null}

      <View style={{ flexGrow: 1, minHeight: th.space.lg }} />

      {canReport(event) ? (
        <Button label={copy.event.report} onPress={() => setSheet(true)} testID="report" />
      ) : (
        <Button label={copy.event.back} variant="secondary" onPress={back} testID="back-to-drive" />
      )}

      <DisputeSheet
        visible={sheet}
        busy={phase === 'busy'}
        failed={phase === 'error'}
        onSubmit={submit}
        onNotDriver={() => {
          setSheet(false);
          router.push(tripEditHref(clientTripId));
        }}
        onClose={() => setSheet(false)}
        testID="dispute-sheet"
      />
    </Screen>
  );
}

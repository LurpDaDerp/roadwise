import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useTrip, useTripEvents, type TripEventView } from '@/data/queries';
import { Banner, Button, Card, EmptyState, Screen, Skeleton, Text, useTheme } from '@/ui';
import { formatPoints } from '@/ui/charts';

import { tripCopy as copy } from './copy';
import {
  cappedCost,
  canReport,
  confidenceLevel,
  confidenceReasons,
  eventStanding,
  measuredLine,
  severityWord,
  standingLabel,
  standingWhy,
  whyItMatters,
} from './detail';
import { DisputeSheet } from './DisputeSheet';
import { Field, FieldText } from './Field';
import { categoryLabel, dateLine, formatClock } from './format';
import { NOTICE_BORDER, TIGHT } from './layout';
import { HOME_HREF, tripEditHref } from './routes';
import { TripTopBar } from './TopBar';
import { EventMiniMap } from './TripMap';
import { useReportEvent, type DisputeInput } from './tripActions';

/**
 * The standing, said out loud, with the sentence that makes it fair — and, for a refusal, the
 * server's own code behind a disclosure, so support has it and §7.0's "never a code in primary
 * text" holds. The whole notice is one element to a screen reader.
 */
function StandingNotice({ event, testID }: { event: TripEventView; testID?: string }) {
  const th = useTheme();
  const [open, setOpen] = useState(false);
  const standing = eventStanding(event);
  const label = standingLabel(standing);
  const why = standingWhy(event);
  if (label === null) return null;
  const code =
    standing === 'reportRefused' || standing === 'reportClosed' || standing === 'reportUnsent'
      ? (event.dispute?.code ?? null)
      : null;

  return (
    <View
      testID={testID}
      style={{
        gap: TIGHT,
        padding: th.space.md,
        borderRadius: th.radius.md,
        borderWidth: NOTICE_BORDER,
        borderColor: th.colors.border,
        backgroundColor: th.colors.surfaceRaised,
      }}
    >
      <View accessible accessibilityRole="text" accessibilityLabel={why === null ? label : `${label}. ${why}`}>
        <Text variant="headline">{label}</Text>
        {why !== null ? (
          <Text variant="subhead" tone="muted">
            {why}
          </Text>
        ) : null}
      </View>
      {code !== null ? (
        <View style={{ alignSelf: 'flex-start', marginLeft: -th.space.lg }}>
          <Button
            label={open ? copy.standing.hideDetails : copy.standing.details}
            variant="ghost"
            size="md"
            onPress={() => setOpen((v) => !v)}
            testID="standing-details"
          />
        </View>
      ) : null}
      {open && code !== null ? (
        <Text variant="footnote" tone="muted" selectable testID="standing-code">
          {copy.standing.code(code)}
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
  const events = eventsQuery.data ?? [];
  const event = events.find((row) => row.id === eventId);
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
  // What the moment cost, after its category's per-trip cap: the raw `deduction` is the
  // pre-cap figure and would contradict the bar D2 draws below it. Read from the row rather than
  // from the standing, because a report that was recorded but not applied (§9.9) leaves the
  // points exactly where they were, and a report still travelling has taken nothing off yet.
  const cost = cappedCost(trip, events, event);
  const underReview = eventStanding(event) === 'reportSending' && cost !== null;

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
            {cost === null ? copy.event.pointsNone : copy.event.pointsLost(formatPoints(cost))}
          </FieldText>
          {underReview ? (
            <Text variant="footnote" tone="muted" testID="points-under-review">
              {copy.event.pointsUnderReview}
            </Text>
          ) : null}
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
        <>
          {eventStanding(event) === 'possible' ? (
            <Text variant="footnote" tone="muted" testID="no-report-reason">
              {copy.standing.possibleNoReport}
            </Text>
          ) : null}
          <Button label={copy.event.back} variant="secondary" onPress={back} testID="back-to-drive" />
        </>
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

import { MIN_SCORED_MILES, MIN_SCORED_S } from '@scoring';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import { formatDistance, type Units } from '@/lib/units';
import { Button, Card, Divider, IconButton, Text, useTheme } from '@/ui';
import { opaque, over } from '@/ui/sky/color';

import { recapCopy } from './copy';
import { EventList } from './EventList';
import { formatDay, formatDuration, formatTimeSpan, spokenDuration } from './format';
import { meritWash } from './merit';
import { MeritFacts } from './MeritFacts';
import type { LocalDrive, LocalDriveEvent } from './model';
import { NotDrivingSheet, ReportSheet } from './ReportSheet';
import { decodeRoute } from './route';
import { RouteMap } from './RouteMap';
import { ShareSheet } from './ShareCard';
import {
  canMarkNotDriving,
  eventRows,
  meritOf,
  notDrivingLabel,
  notDrivingRefusal,
  scoreState,
  type ReportReason,
  type ScoreState,
} from './summary';

export type SummaryViewProps = {
  drive: LocalDrive;
  events: readonly LocalDriveEvent[];
  /** Right after the drive ended: count the score up once. Otherwise static. */
  fresh: boolean;
  /** "Wasn't driving" uses left this month (from the server summary); null when unknown. */
  notDrivingLeft: number | null;
  now: number;
  onBack: () => void;
  onReport: (eventId: string, reason: Exclude<ReportReason, 'not_driving'>) => Promise<void>;
  onNotDriving: () => Promise<void>;
};

function StateBlock({ title, body, testID }: { title: string; body: string; testID: string }) {
  return (
    <View testID={testID} style={{ gap: 4, flexShrink: 1 }}>
      <Text variant="title1">{title}</Text>
      <Text variant="callout" tone="muted">
        {body}
      </Text>
    </View>
  );
}

/** What the score card says when the drive has no score. */
function StateHead({ state, drive, units }: { state: Exclude<ScoreState, { kind: 'score' }>; drive: LocalDrive; units: Units }) {
  const s = recapCopy.states;
  switch (state.kind) {
    case 'too_short':
      return <StateBlock testID="state-too-short" title={s.tooShort.title} body={s.tooShort.body(formatDistance(MIN_SCORED_MILES, units), MIN_SCORED_S / 60)} />;
    case 'not_scored':
      return <StateBlock testID="state-not-scored" title={s.notScored.title} body={recapCopy.notScoredWhy[drive.reason ?? drive.result?.reason ?? ''] ?? s.notScored.body} />;
    case 'not_driving':
      return <StateBlock testID="state-not-driving" title={s.notDriving.title} body={s.notDriving.body} />;
    case 'recording':
      return <StateBlock testID="state-recording" title={s.recording.title} body={s.recording.body} />;
  }
}

/**
 * The drive recap, top to bottom: time and distance (and how it started or ended on its own), the
 * route map, then the score card: the hero, the share card's smaller sibling (the tier's icon,
 * score, distance and time in the tier's colour on a soft wash of it) with Share right beside it,
 * and the drive's events under it. "Wasn't driving" sits in a fixed footer.
 */
export function SummaryView({ drive, events, fresh, notDrivingLeft, now, onBack, onReport, onNotDriving }: SummaryViewProps) {
  const t = useTheme();
  const units = useUnits();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [confirmNotDriving, setConfirmNotDriving] = useState(false);
  // "I wasn't driving" in a report: the confirm opens once the report sheet has gone (iOS shows
  // one modal at a time and refuses a second while the first is still leaving).
  const [notDrivingNext, setNotDrivingNext] = useState(false);
  const [sharing, setSharing] = useState(false);

  const state = useMemo(() => scoreState(drive, events), [drive, events]);
  const tier = useMemo(() => meritOf(drive, events), [drive, events]);
  const rows = useMemo(() => eventRows(events, units), [events, units]);
  const runs = useMemo(() => decodeRoute(drive.polyline), [drive.polyline]);
  const score = state.kind === 'score' ? state.value : null;
  const selected = events.find((e) => e.id === selectedId) ?? null;
  const reportEvent = events.find((e) => e.id === reporting) ?? null;
  const notDrivingOk = canMarkNotDriving(drive, now) && notDrivingLeft !== 0;
  const refusal = notDrivingRefusal(drive);
  // The events list for a drive that is kept; a drive in progress or marked has none to work on.
  const listed = state.kind === 'score' || state.kind === 'too_short' || state.kind === 'not_scored';
  const wash = tier !== null && score !== null ? meritWash(tier, t.scheme) : null;
  const surface = opaque(t.colors.surface);
  const share = (
    <Button label={recapCopy.share} icon="share-outline" size="sm" variant="secondary" onPress={() => setSharing(true)} testID="share" />
  );

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: t.space.lg, gap: t.space.lg }} testID="drive-summary">
        {/* 1. Time and distance */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: t.space.md }}>
          <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={onBack} testID="back" variant="surface" />
          <View
            style={{ flex: 1 }}
            testID="summary-trip"
            accessible
            accessibilityRole="header"
            accessibilityLabel={`${spokenDuration(drive.durationS)}, ${formatDistance(drive.miles, units, { spoken: true })}. ${formatDay(drive.startedAt)}, ${formatTimeSpan(drive.startedAt, drive.endedAt)}`}
          >
            <Text variant="title2">
              {formatDuration(drive.durationS)} · {formatDistance(drive.miles, units)}
            </Text>
            <Text variant="subhead" tone="muted">
              {formatDay(drive.startedAt)} · {formatTimeSpan(drive.startedAt, drive.endedAt)}
            </Text>
          </View>
        </View>

        {/* 2. Route map */}
        <RouteMap runs={runs} events={rows.map((r) => r.event)} highlighted={selected} />

        {/* 3. The score card: the hero (or the drive's state) with Share beside it, then the events */}
        <Card testID="summary-score-card">
          {state.kind === 'score' ? (
            <View style={{ gap: t.space.xs }}>
              <View
                testID="summary-hero"
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: t.space.md,
                  padding: wash ? t.space.md : 0,
                  margin: wash ? -t.space.sm : 0,
                  borderRadius: t.radius.lg,
                  borderCurve: 'continuous',
                  backgroundColor: wash ?? 'transparent',
                }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <MeritFacts
                    size="hero"
                    score={score}
                    miles={drive.miles}
                    durationS={drive.durationS}
                    units={units}
                    tier={tier}
                    surfaces={wash ? [surface, over(surface, wash)] : [surface]}
                    plainInk={t.colors.text}
                    countUp={fresh}
                    testID="summary-facts"
                  />
                </View>
                {share}
              </View>
              {state.notSynced ? (
                <Text variant="footnote" tone="muted" testID="state-not-synced" style={{ paddingTop: t.space.sm }}>
                  {recapCopy.notSynced}
                </Text>
              ) : null}
            </View>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: t.space.md }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <StateHead state={state} drive={drive} units={units} />
              </View>
              {share}
            </View>
          )}
          {listed ? (
            <>
              <Divider />
              <EventList
                rows={rows}
                allowNotDriving={notDrivingOk}
                selectedId={selectedId}
                onSelect={(id) => setSelectedId((cur) => (cur === id ? null : id))}
                onReport={setReporting}
              />
            </>
          ) : null}
        </Card>
      </ScrollView>

      {/* "Wasn't driving", when it is on offer or the server said why not */}
      {notDrivingOk || refusal ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: t.space.md,
            paddingHorizontal: t.space.lg,
            paddingTop: t.space.md,
            borderTopWidth: 1,
            borderTopColor: t.colors.divider,
            backgroundColor: t.colors.bg,
          }}
        >
          {notDrivingOk ? (
            <Button
              label={notDrivingLabel(notDrivingLeft)}
              variant="ghost"
              size="sm"
              onPress={() => setConfirmNotDriving(true)}
              testID="not-driving"
              style={{ alignSelf: 'flex-start' }}
            />
          ) : (
            <Text variant="footnote" tone="muted" testID="not-driving-refused" style={{ flex: 1 }}>
              {refusal}
            </Text>
          )}
        </View>
      ) : null}

      <ReportSheet
        event={reportEvent}
        allowNotDriving={notDrivingOk}
        onClose={() => setReporting(null)}
        onSend={onReport}
        onNotDriving={() => {
          setNotDrivingNext(true);
          setReporting(null);
        }}
        onDismiss={() => {
          if (!notDrivingNext) return;
          setNotDrivingNext(false);
          setConfirmNotDriving(true);
        }}
      />
      <NotDrivingSheet visible={confirmNotDriving} left={notDrivingLeft} onClose={() => setConfirmNotDriving(false)} onConfirm={onNotDriving} />
      <ShareSheet visible={sharing} onClose={() => setSharing(false)} data={{ runs, miles: drive.miles, durationS: drive.durationS, score, tier: score === null ? null : tier, units }} />
    </View>
  );
}

import { MIN_SCORED_MILES } from '@scoring';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import { formatDistance, type Units } from '@/lib/units';
import { Button, Card, Divider, IconButton, Pill, PointsCounter, Text, useTheme } from '@/ui';

import { formatDay, formatDuration, formatTimeSpan, spokenDuration } from './format';
import type { LocalDrive, LocalDriveEvent } from './model';
import { Receipt } from './Receipt';
import { NotDrivingSheet, ReportSheet } from './ReportSheet';
import { decodeRoute } from './route';
import { RouteMap } from './RouteMap';
import { ShareSheet } from './ShareCard';
import {
  canMarkNotDriving,
  endNote,
  notDrivingLabel,
  notDrivingRefusal,
  pointsState,
  receipt,
  type PointsState,
  type ReportReason,
} from './summary';

export type SummaryViewProps = {
  drive: LocalDrive;
  events: readonly LocalDriveEvent[];
  /** Right after the drive ended: count the points up and celebrate. Otherwise static. */
  fresh: boolean;
  /** "Wasn't driving" uses left this month (from the server summary); null when unknown. */
  notDrivingLeft: number | null;
  /** For the share card: the server's latest Safety Rating. */
  safetyRating: number | null;
  /** Whether that rating counts (25+ mi in 30 days); an unranked share card says "Unranked". */
  ranked?: boolean;
  /** The newest drive on this phone; "Wasn't driving" is offered only there. Null while unknown. */
  latestClientTripId: string | null;
  now: number;
  onBack: () => void;
  onOpenDrive: (clientTripId: string) => void;
  onReport: (eventId: string, reason: Exclude<ReportReason, 'not_driving'>) => Promise<void>;
  onNotDriving: () => Promise<void>;
};

const NOT_SCORED_WHY: Record<string, string> = {
  spoofed: "This drive's location didn't look right, so it wasn't scored.",
  implausible: "Something about this drive didn't add up, so it wasn't scored.",
};

function StateBlock({ title, body, testID }: { title: string; body: string; testID: string }) {
  return (
    <View testID={testID} style={{ gap: 4 }}>
      <Text variant="title1">{title}</Text>
      <Text variant="callout" tone="muted">
        {body}
      </Text>
    </View>
  );
}

/** The drive's total in bold, counting up on a fresh summary. */
function Total({ value, fresh, estimate }: { value: number; fresh: boolean; estimate: boolean }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.space.sm }}>
        <Text variant="label" tone="muted">
          Points this drive
        </Text>
        {estimate ? <Pill label="Estimate" tone="info" icon="cloud-offline-outline" testID="estimate" /> : null}
      </View>
      <PointsCounter value={value} from={fresh ? 0 : undefined} react={fresh} size="hero" signed label="Points this drive" testID="summary-points" />
    </View>
  );
}

function PointsHead({ state, total, drive, fresh, units, onOpenDrive }: { state: PointsState; total: number | null; drive: LocalDrive; fresh: boolean; units: Units; onOpenDrive: (id: string) => void }) {
  const t = useTheme();
  switch (state.kind) {
    case 'points':
      return (
        <View style={{ gap: t.space.xs }}>
          <Total value={state.value} fresh={fresh} estimate={state.estimate} />
          {state.estimate ? (
            <Text variant="footnote" tone="muted">
              Your final points arrive once this drive uploads.
            </Text>
          ) : null}
        </View>
      );
    case 'too_short':
      return <StateBlock testID="state-too-short" title="Too short to score" body={`Drives under ${formatDistance(MIN_SCORED_MILES, units)} don't earn or lose points.`} />;
    case 'not_scored':
      return (
        <StateBlock
          testID="state-not-scored"
          title="Not scored"
          body={NOT_SCORED_WHY[drive.reason ?? drive.result?.reason ?? ''] ?? "This drive didn't get a score."}
        />
      );
    case 'not_driving':
      return <StateBlock testID="state-not-driving" title="Marked as not driving" body="No points either way, and your streak isn't affected." />;
    case 'pending':
      return <StateBlock testID="state-pending" title="Scoring…" body="Your points show up as soon as this drive uploads." />;
    case 'recording':
      return <StateBlock testID="state-recording" title="Drive in progress" body="Points land here when the drive ends." />;
    case 'failed':
      return (
        <View style={{ gap: t.space.md }}>
          {total !== null ? <Total value={total} fresh={false} estimate={false} /> : null}
          <StateBlock testID="state-failed" title="Not synced yet" body="We'll keep trying. Your points show up once it uploads." />
        </View>
      );
    case 'merged':
      return (
        <View style={{ gap: t.space.md }} testID="state-merged">
          <StateBlock
            testID="state-merged-text"
            title="Added to your last drive"
            body="You started again within 5 minutes, so the two count as one drive."
          />
          {state.into ? (
            <Button label="Open that drive" variant="secondary" size="sm" onPress={() => onOpenDrive(state.into!)} style={{ alignSelf: 'flex-start' }} />
          ) : null}
        </View>
      );
  }
}

/** The drive summary, top to bottom: time and distance, the route map, the points; actions in a fixed footer. */
export function SummaryView({ drive, events, fresh, notDrivingLeft, safetyRating, ranked = false, latestClientTripId, now, onBack, onOpenDrive, onReport, onNotDriving }: SummaryViewProps) {
  const t = useTheme();
  const units = useUnits();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [confirmNotDriving, setConfirmNotDriving] = useState(false);
  const [sharing, setSharing] = useState(false);

  const state = pointsState(drive);
  const points = useMemo(() => receipt(drive, events, units), [drive, events, units]);
  const runs = useMemo(() => decodeRoute(drive.polyline), [drive.polyline]);
  const selected = events.find((e) => e.id === selectedId) ?? null;
  const reportEvent = events.find((e) => e.id === reporting) ?? null;
  const net = state.kind === 'points' ? state.value : null;
  const showReceipt =
    (state.kind === 'points' || state.kind === 'failed' || state.kind === 'pending') &&
    (points.earned !== null || points.total !== null || points.deductions.length > 0);
  const notDrivingOk = canMarkNotDriving(drive, latestClientTripId, now);
  const refusal = notDrivingRefusal(drive);
  const endedNote = endNote(drive);

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
            accessibilityLabel={`${spokenDuration(drive.durationS)}, ${formatDistance(drive.miles, units, { spoken: true })}. ${formatDay(drive.startedAt)}, ${formatTimeSpan(drive.startedAt, drive.endedAt)}${endedNote ? `. ${endedNote}` : ''}`}
          >
            <Text variant="title2">
              {formatDuration(drive.durationS)} · {formatDistance(drive.miles, units)}
            </Text>
            <Text variant="subhead" tone="muted">
              {formatDay(drive.startedAt)} · {formatTimeSpan(drive.startedAt, drive.endedAt)}
            </Text>
            {endedNote ? (
              <Text variant="footnote" tone="muted" testID="summary-end-note">
                {endedNote}
              </Text>
            ) : null}
          </View>
        </View>

        {/* 2. Route map */}
        <RouteMap runs={runs} events={events} highlighted={selected} />

        {/* 3. Points: the total in bold, then what was earned and lost */}
        <Card testID="summary-points-card">
          <PointsHead state={state} total={points.total} drive={drive} fresh={fresh} units={units} onOpenDrive={onOpenDrive} />
          {showReceipt ? (
            <>
              <Divider />
              <Receipt receipt={points} selectedId={selectedId} onSelect={(id) => setSelectedId((cur) => (cur === id ? null : id))} onReport={setReporting} />
            </>
          ) : null}
        </Card>
      </ScrollView>

      {/* Actions */}
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
        <View style={{ flex: 1 }}>
          {notDrivingOk ? (
            <Button
              label={notDrivingLabel(notDrivingLeft)}
              variant="ghost"
              size="sm"
              onPress={() => setConfirmNotDriving(true)}
              disabled={notDrivingLeft === 0}
              testID="not-driving"
              style={{ alignSelf: 'flex-start' }}
            />
          ) : refusal ? (
            <Text variant="footnote" tone="muted" testID="not-driving-refused">
              {refusal}
            </Text>
          ) : null}
        </View>
        <Button label="Share" icon="share-outline" onPress={() => setSharing(true)} testID="share" />
      </View>

      <ReportSheet
        event={reportEvent}
        allowNotDriving={notDrivingOk && notDrivingLeft !== 0}
        onClose={() => setReporting(null)}
        onSend={onReport}
        onNotDriving={() => {
          setReporting(null);
          setConfirmNotDriving(true);
        }}
      />
      <NotDrivingSheet
        visible={confirmNotDriving}
        left={notDrivingLeft}
        points={net}
        onClose={() => setConfirmNotDriving(false)}
        onConfirm={onNotDriving}
      />
      <ShareSheet
        visible={sharing}
        onClose={() => setSharing(false)}
        data={{
          startedAt: drive.startedAt,
          runs,
          miles: drive.miles,
          durationS: drive.durationS,
          net,
          safetyRating: drive.result?.progress.safetyRating ?? safetyRating,
          ranked: drive.result?.progress.ranked ?? ranked,
          clean: drive.clean === true,
          units,
        }}
      />
    </View>
  );
}

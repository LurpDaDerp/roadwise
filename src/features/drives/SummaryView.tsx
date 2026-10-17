import { Ionicons } from '@expo/vector-icons';
import { MIN_SCORED_MILES, type EventType, type Tier } from '@scoring';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import { formatDistance, type Units } from '@/lib/units';
import { Button, Card, IconButton, Pill, PointsCounter, StreakFlame, Text, useTheme } from '@/ui';

import { BreakdownList, BreakdownToggle } from './Breakdown';
import { EVENT_ICON, formatDay, formatDuration, formatTimeSpan, routeLine, spokenDuration, spokenRoute, TIER_SIGNAL, worseTier } from './format';
import type { LocalDrive, LocalDriveEvent } from './model';
import { NotDrivingSheet, ReportSheet } from './ReportSheet';
import { decodeRoute } from './route';
import { RouteMap } from './RouteMap';
import { ShareSheet } from './ShareCard';
import {
  breakdownLines,
  canMarkNotDriving,
  celebrations,
  endNote,
  isRemoved,
  notDrivingLabel,
  notDrivingRefusal,
  pointsState,
  streakLine,
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
  spoofed: "This drive's location data didn't look right, so it wasn't scored.",
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

function PointsBlock({ state, drive, fresh, units, onOpenDrive }: { state: PointsState; drive: LocalDrive; fresh: boolean; units: Units; onOpenDrive: (id: string) => void }) {
  const t = useTheme();
  switch (state.kind) {
    case 'points':
      return (
        <View style={{ gap: t.space.xs }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.space.sm }}>
            <Text variant="label" tone="muted">
              {state.value < 0 ? 'Points this drive' : 'Points earned'}
            </Text>
            {state.estimate ? (
              <Pill label="Estimate" tone="info" icon="cloud-offline-outline" testID="estimate" />
            ) : drive.clean ? (
              <Pill label="Clean drive" tone="clean" icon="checkmark-circle" emphasis="solid" testID="clean-badge" />
            ) : null}
          </View>
          <PointsCounter
            value={state.value}
            from={fresh ? 0 : undefined}
            react={fresh}
            size="hero"
            signed
            label={state.value < 0 ? 'Points this drive' : 'Points earned'}
            testID="summary-points"
          />
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
      return <StateBlock testID="state-failed" title="Not synced yet" body="We'll keep trying. Your points show up once it uploads." />;
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

type Counter = { key: string; label: string; n: number; tier: Tier | null; icon: React.ComponentProps<typeof Ionicons>['name'] };

function counters(drive: LocalDrive, events: readonly LocalDriveEvent[]): Counter[] {
  const worst = (types: EventType[]) =>
    events.filter((e) => types.includes(e.type) && !isRemoved(e)).reduce<Tier | null>((w, e) => worseTier(w, e.tier), null);
  const c = drive.counts;
  const list: Counter[] = [
    { key: 'pickups', label: 'Phone pickups', n: c.pickups, tier: worst(['phone_pickup', 'phone_handling']), icon: EVENT_ICON.phone_pickup },
    { key: 'speeding', label: 'Speeding', n: c.speeding, tier: worst(['speeding']), icon: EVENT_ICON.speeding },
    { key: 'hardBrake', label: 'Hard braking', n: c.hardBrake, tier: worst(['hard_brake']), icon: EVENT_ICON.hard_brake },
    { key: 'hardAccel', label: 'Hard acceleration', n: c.hardAccel, tier: worst(['hard_accel']), icon: EVENT_ICON.hard_accel },
    { key: 'hardCorner', label: 'Cornering', n: c.hardCorner, tier: worst(['hard_corner']), icon: EVENT_ICON.hard_corner },
  ];
  // A DashPal drive (its x1.25), or any DashPal event on the drive, adds the DashPal tile.
  const dashcam = c.eyesOff + c.drowsy;
  if ((drive.result?.breakdown.dashcamMult ?? 1) > 1 || dashcam > 0) {
    list.push({ key: 'dashpal', label: 'DashPal events', n: dashcam, tier: worst(['eyes_off', 'drowsy']), icon: 'videocam-outline' });
  }
  return list;
}

function CounterTile({ counter }: { counter: Counter }) {
  const t = useTheme();
  const zero = counter.n === 0;
  const sig = t.colors.signal[zero ? 'clean' : counter.tier ? TIER_SIGNAL[counter.tier] : 'severe'];
  return (
    <View
      testID={`counter-${counter.key}`}
      accessible
      accessibilityLabel={`${counter.label}: ${counter.n}${zero ? ', none' : ''}`}
      style={{ flexBasis: '30%', flexGrow: 1, gap: 2, padding: t.space.md, borderRadius: t.radius.lg, borderCurve: 'continuous', backgroundColor: sig.faint }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs }}>
        <Ionicons name={zero ? 'checkmark-circle' : counter.icon} size={t.size.iconSm} color={sig.text} />
        <Text variant="stat" style={{ color: sig.text }}>
          {counter.n}
        </Text>
      </View>
      <Text variant="caption" tone="muted" numberOfLines={2}>
        {counter.label}
      </Text>
    </View>
  );
}

/** The drive summary: the spec's seven blocks, top to bottom, with a fixed footer. */
export function SummaryView({ drive, events, fresh, notDrivingLeft, safetyRating, ranked = false, latestClientTripId, now, onBack, onOpenDrive, onReport, onNotDriving }: SummaryViewProps) {
  const t = useTheme();
  const units = useUnits();
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [confirmNotDriving, setConfirmNotDriving] = useState(false);
  const [sharing, setSharing] = useState(false);

  const state = pointsState(drive);
  const { lines, note } = useMemo(() => breakdownLines(drive, events, units), [drive, events, units]);
  const streak = streakLine(drive);
  const party = celebrations(drive);
  const runs = useMemo(() => decodeRoute(drive.polyline), [drive.polyline]);
  const selected = events.find((e) => e.id === selectedId) ?? null;
  const reportEvent = events.find((e) => e.id === reporting) ?? null;
  const net = state.kind === 'points' ? state.value : null;
  const showBreakdown = state.kind === 'points' || state.kind === 'failed' || state.kind === 'pending';
  const notDrivingOk = canMarkNotDriving(drive, latestClientTripId, now);
  const refusal = notDrivingRefusal(drive);
  const endedNote = endNote(drive);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: t.space.lg, gap: t.space.lg }} testID="drive-summary">
        {/* 1. Title */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: t.space.md }}>
          <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={onBack} testID="back" variant="surface" />
          <View
            style={{ flex: 1 }}
            accessible
            accessibilityRole="header"
            accessibilityLabel={`${formatDay(drive.startedAt)}, ${formatTimeSpan(drive.startedAt, drive.endedAt)}, ${spokenRoute(drive)}${endedNote ? `. ${endedNote}` : ''}`}
          >
            <Text variant="title2">{formatDay(drive.startedAt)}</Text>
            <Text variant="subhead" tone="muted">
              {formatTimeSpan(drive.startedAt, drive.endedAt)} · {routeLine(drive)}
            </Text>
            {endedNote ? (
              <Text variant="footnote" tone="muted" testID="summary-end-note">
                {endedNote}
              </Text>
            ) : null}
          </View>
        </View>

        {/* 2. Points, 3. Breakdown */}
        <Card variant="hero">
          <PointsBlock state={state} drive={drive} fresh={fresh} units={units} onOpenDrive={onOpenDrive} />
          {showBreakdown && (lines.length > 0 || note) ? <BreakdownToggle open={open} onPress={() => setOpen((v) => !v)} /> : null}
        </Card>
        {open ? (
          <BreakdownList
            lines={lines}
            note={note}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId((cur) => (cur === id ? null : id))}
            onReport={setReporting}
          />
        ) : null}

        {/* 4. Streak line (+ anything unlocked) */}
        {streak ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }} testID="streak-line">
            <StreakFlame count={drive.result?.streak.after ?? 0} state={streak.state} />
            <Text variant="headline" style={{ flex: 1 }}>
              {streak.text}
            </Text>
          </View>
        ) : null}
        {party.length > 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }} testID="celebrations" accessibilityLabel={`Unlocked: ${party.map((p) => p.label).join(', ')}`}>
            {party.map((p) => (
              <Pill key={p.key} label={p.label} icon={p.icon} tone="gold" emphasis="solid" />
            ))}
          </View>
        ) : null}

        {/* 5. Stats row */}
        <View style={{ gap: t.space.sm }}>
          <View style={{ flexDirection: 'row', gap: t.space.xl }}>
            <View accessible accessibilityLabel={`Distance ${formatDistance(drive.miles, units, { spoken: true })}`}>
              <Text variant="label" tone="muted">
                Distance
              </Text>
              <Text variant="stat">{formatDistance(drive.miles, units)}</Text>
            </View>
            <View accessible accessibilityLabel={`Time ${spokenDuration(drive.durationS)}`}>
              <Text variant="label" tone="muted">
                Time
              </Text>
              <Text variant="stat">{formatDuration(drive.durationS)}</Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
            {counters(drive, events).map((c) => (
              <CounterTile key={c.key} counter={c} />
            ))}
          </View>
        </View>

        {/* 6. Route map */}
        <RouteMap runs={runs} events={events} highlighted={selected} />
      </ScrollView>

      {/* 7. Footer */}
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

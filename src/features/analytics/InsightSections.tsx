import type { ReactNode } from 'react';
import { View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import { Text, useTheme } from '@/ui';

import { analyticsCopy } from './copy';
import { pickupView, roadView, type PickupTiming, type SpeedingByRoad } from './insights';
import { BAND_WORDS } from './model';

const r = analyticsCopy.category.roads;
const p = analyticsCopy.category.pickupTiming;

/** A section of a category sheet under its numbers: a header, an optional headline, and its rows. */
function Section({ title, headline, children, testID }: { title: string; headline: string | null; children: ReactNode; testID: string }) {
  const t = useTheme();
  return (
    <View testID={testID} style={{ gap: t.space.sm, paddingTop: t.space.sm }}>
      <Text variant="headline" accessibilityRole="header">
        {title}
      </Text>
      {headline ? (
        <Text variant="subhead" testID={`${testID}-headline`}>
          {headline}
        </Text>
      ) : null}
      <View style={{ gap: t.space.sm }}>{children}</View>
    </View>
  );
}

/**
 * A row's words for a screen reader: commas for the dots, the units and minutes in words, ranges
 * with "to" ("Speed, 25 to 45 miles per hour, 50% of pickups").
 */
function spokenRow(text: string): string {
  return text
    .replace(/ · /g, ', ')
    .replace(/\bmph\b/g, 'miles per hour')
    .replace(/km\/h/g, 'kilometers per hour')
    .replace(/\bmin\b/g, 'minutes')
    .replace(/(\d+)\+ (miles per hour|kilometers per hour)/g, '$1 $2 and up')
    .replace(/(\d)–(\d)/g, '$1 to $2')
    .replace(/–/g, ' to ');
}

/** One row: what it is, then its numbers (`parts`, shown with dots between) in muted ink; read as one line. */
function Row({ label, parts, testID }: { label: string; parts: string[]; testID: string }) {
  return (
    <View accessible accessibilityLabel={spokenRow([label, ...parts].join(', '))} testID={testID} style={{ gap: 2 }}>
      <Text variant="subhead">{label}</Text>
      <Text variant="footnote" tone="muted" testID={`${testID}-line`}>
        {parts.join(' · ')}
      </Text>
    </View>
  );
}

/**
 * Speed's "Where you speed", under its rate line: the range's speeding time by kind of road
 * (streets, main roads, highways, named by their limits in the driver's units), each row its share
 * of the speeding and, when the drives keep it, its share of the driving with a known limit. When
 * one kind holds half the speeding or more, a headline names it, adding how little of the driving is
 * there when that share is 15 points or more under its speeding share. A comment, never a score.
 */
export function RoadSection({ roads }: { roads: SpeedingByRoad }) {
  const units = useUnits();
  const v = roadView(roads);
  const most = v.most ? v.rows.find((x) => x.kind === v.most)! : null;
  const headline = most ? r.headline(most.kind, v.gap ? most.drivingPct : null) : null;
  return (
    <Section title={r.title} headline={headline} testID="category-roads">
      {v.rows.map((row) => (
        <Row
          key={row.kind}
          label={r.label(row.kind, units)}
          parts={row.drivingPct === null ? [r.speeding(row.speedingPct)] : [r.speeding(row.speedingPct), r.driving(row.drivingPct)]}
          testID={`category-roads-${row.kind}`}
        />
      ))}
    </Section>
  );
}

/**
 * Phone use's "When pickups happen", above how a pickup is judged: a headline (the first five
 * minutes, the end of the drive, highway speeds, else the busiest time of day) and three rows giving
 * the top speed, moment in the drive and time of day with their shares of the range's pickups. A
 * comment, never a score.
 */
export function PickupSection({ timing }: { timing: PickupTiming }) {
  const units = useUnits();
  const v = pickupView(timing);
  const h = v.headline;
  const headline = h.kind === 'band' ? p.band(h.band) : p[h.kind];
  return (
    <Section title={p.title} headline={headline} testID="category-pickups">
      {v.speed ? <Row label={p.speedRow} parts={[p.speed(v.speed.key, units), p.share(v.speed.pct)]} testID="category-pickups-speed" /> : null}
      <Row label={p.momentRow} parts={[p.moment(v.moment.key), p.share(v.moment.pct)]} testID="category-pickups-moment" />
      <Row label={p.timeRow} parts={[BAND_WORDS[v.band.key] ?? BAND_WORDS[0]!, p.share(v.band.pct)]} testID="category-pickups-time" />
    </Section>
  );
}

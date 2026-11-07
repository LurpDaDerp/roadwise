import { ACHIEVEMENTS } from '@scoring';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import type { MyWrapped, PercentileKey, WrappedCore } from '@/data/server/wrapped';
import { formatDuration } from '@/features/drives/format';
import { formatDistance, type Units } from '@/lib/units';
import { Text, useTheme, withAlpha } from '@/ui';

import { ArchetypeIcon } from './ArchetypeIcon';
import { archetypeDescription, archetypeName, archetypePattern, CHIP_ALPHA, SOFT_INK_ALPHA } from './archetypes';
import { wrappedCopy as copy } from './copy';
import { bandLabel, CATEGORY_LABEL, percent, percentileText, ratingChangeText, ratingText, rateText, weekdayName, type SlideId } from './format';
import type { WrappedPlaces } from './places';

const WHITE = '#FFFFFF';
const SOFT = withAlpha(WHITE, SOFT_INK_ALPHA);

/** What every slide reads: the month's numbers, the driver's own extras (never in a shared copy) and the viewer's units. */
export interface StoryView {
  kind: 'own' | 'shared';
  /** The viewer's own month: the own story, or a shared copy of their own (it still has no extras). The wording reads "your". */
  yours: boolean;
  core: WrappedCore;
  /** The own story's habits and goals; null on a shared copy. */
  own: Pick<MyWrapped, 'busiestBandStartHour' | 'weekdayDrives' | 'weekendDrives' | 'goalsCompleted'> | null;
  /** Badges earned in the month. */
  badgesCount: number;
  /** The own story's Places (from this phone's drives); null on a shared copy. */
  places: WrappedPlaces | null;
  units: Units;
  /** "October". */
  month: string;
}

/** A "Better than 72% of drivers" chip, or nothing when hidden. */
export function PercentileChip({ k, x, testID }: { k: PercentileKey; x: number | null; testID?: string }) {
  const t = useTheme();
  const text = percentileText(k, x);
  if (text === null) return null;
  return (
    <View style={{ alignSelf: 'flex-start', borderRadius: t.radius.pill, paddingHorizontal: t.space.md, paddingVertical: t.space.xs, backgroundColor: withAlpha(WHITE, CHIP_ALPHA) }} testID={testID}>
      <Text variant="footnote" style={{ color: WHITE }}>
        {text}
      </Text>
    </View>
  );
}

function SlideTitle({ children }: { children: string }) {
  return (
    <Text variant="title1" style={{ color: WHITE }} accessibilityRole="header">
      {children}
    </Text>
  );
}

/** A number and its label, the big one of a slide or one of a grid, with its chip. */
function Stat({ value, label, sub, chip, big, testID }: { value: string; label: string; sub?: string | null; chip?: ReactNode; big?: boolean; testID?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.xs }} testID={testID}>
      <Text variant="label" style={{ color: SOFT }}>
        {label}
      </Text>
      <Text variant={big ? 'display' : 'stat'} style={{ color: WHITE }} numberOfLines={2} testID={testID ? `${testID}-value` : undefined}>
        {value}
      </Text>
      {sub ? (
        <Text variant="subhead" style={{ color: SOFT }} testID={testID ? `${testID}-sub` : undefined}>
          {sub}
        </Text>
      ) : null}
      {chip}
    </View>
  );
}

function Body({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <View style={{ flex: 1, justifyContent: 'center', gap: t.space.xl }}>{children}</View>;
}

function Grid({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: t.space.xl, columnGap: t.space.lg }}>{children}</View>;
}

const Cell = ({ children }: { children: ReactNode }) => <View style={{ flexBasis: '45%', flexGrow: 1 }}>{children}</View>;

function IntroSlide({ v }: { v: StoryView }) {
  const t = useTheme();
  return (
    <Body>
      <Text variant="hero" style={{ color: WHITE }} accessibilityRole="header" testID="wrapped-intro-title">
        {v.yours ? copy.intro.own(v.month) : copy.intro.shared(v.month)}
      </Text>
      <Text variant="title3" style={{ color: SOFT, marginTop: -t.space.md }}>
        {v.yours ? copy.intro.ownBody : copy.intro.sharedBody}
      </Text>
    </Body>
  );
}

function TotalsSlide({ v }: { v: StoryView }) {
  const c = v.core;
  return (
    <Body>
      <SlideTitle>{copy.totals.title}</SlideTitle>
      <Stat big value={formatDistance(c.miles, v.units, { digits: 0 })} label={copy.totals.distance} chip={<PercentileChip k="miles" x={c.percentiles.miles} testID="wrapped-chip-miles" />} testID="wrapped-distance" />
      <Grid>
        <Cell>
          <Stat value={formatDuration(c.durationS)} label={copy.totals.time} testID="wrapped-time" />
        </Cell>
        <Cell>
          <Stat value={String(c.drives)} label={copy.totals.drives} testID="wrapped-drives" />
        </Cell>
        <Cell>
          <Stat value={formatDistance(c.avgDriveMiles, v.units)} label={copy.totals.avg} testID="wrapped-avg" />
        </Cell>
        <Cell>
          <Stat value={formatDistance(c.longestDriveMiles, v.units)} label={copy.totals.longest} testID="wrapped-longest" />
        </Cell>
      </Grid>
    </Body>
  );
}

function SafetySlide({ v }: { v: StoryView }) {
  const c = v.core;
  return (
    <Body>
      <SlideTitle>{copy.safety.title}</SlideTitle>
      <Stat big value={c.avgScore === null ? '—' : String(c.avgScore)} label={copy.safety.avgScore} chip={<PercentileChip k="avgScore" x={c.percentiles.avgScore} testID="wrapped-chip-avgScore" />} testID="wrapped-avg-score" />
      <Grid>
        <Cell>
          <Stat value={ratingText(c.ratingEnd)} label={copy.safety.rating} sub={ratingChangeText(c.ratingStart, c.ratingEnd, v.month)} testID="wrapped-rating" />
        </Cell>
        <Cell>
          <Stat
            value={percent(c.cleanShare)}
            label={copy.safety.clean}
            sub={copy.safety.cleanOf(c.cleanDrives, c.drives)}
            chip={<PercentileChip k="cleanShare" x={c.percentiles.cleanShare} testID="wrapped-chip-cleanShare" />}
            testID="wrapped-clean"
          />
        </Cell>
        {c.longestCleanDriveMiles !== null ? (
          <Cell>
            <Stat value={formatDistance(c.longestCleanDriveMiles, v.units)} label={copy.safety.longestClean} testID="wrapped-longest-clean" />
          </Cell>
        ) : null}
      </Grid>
    </Body>
  );
}

function SmoothnessSlide({ v }: { v: StoryView }) {
  const c = v.core;
  const best = c.bestCategory;
  const bestScore = best === null ? null : c.categories[best];
  return (
    <Body>
      <SlideTitle>{copy.smoothness.title}</SlideTitle>
      <Stat big value={rateText(c.hardPer100, v.units)} label={copy.smoothness.hard} chip={<PercentileChip k="hardPer100" x={c.percentiles.hardPer100} testID="wrapped-chip-hardPer100" />} testID="wrapped-hard" />
      {best !== null && bestScore !== null ? <Stat value={`${CATEGORY_LABEL[best]} · ${bestScore}`} label={copy.smoothness.best} testID="wrapped-best" /> : null}
    </Body>
  );
}

function PhoneSpeedSlide({ v }: { v: StoryView }) {
  const t = useTheme();
  const c = v.core;
  return (
    <Body>
      <SlideTitle>{copy.phoneSpeed.title}</SlideTitle>
      <Stat value={rateText(c.pickupsPer100, v.units)} label={copy.phoneSpeed.pickups} chip={<PercentileChip k="pickupsPer100" x={c.percentiles.pickupsPer100} testID="wrapped-chip-pickupsPer100" />} testID="wrapped-pickups" />
      <Stat value={rateText(c.speedingPer100, v.units)} label={copy.phoneSpeed.speeding} chip={<PercentileChip k="speedingPer100" x={c.percentiles.speedingPer100} testID="wrapped-chip-speedingPer100" />} testID="wrapped-speeding" />
      <Text variant="footnote" style={{ color: SOFT, marginTop: t.space.sm }}>
        {copy.phoneSpeed.note}
      </Text>
    </Body>
  );
}

function HabitsSlide({ v }: { v: StoryView }) {
  const o = v.own;
  return (
    <Body>
      <SlideTitle>{copy.habits.title}</SlideTitle>
      <Stat big value={weekdayName(v.core.busiestWeekday)} label={copy.habits.day} testID="wrapped-day" />
      {o ? (
        <Grid>
          <Cell>
            <Stat value={bandLabel(o.busiestBandStartHour)} label={copy.habits.time} testID="wrapped-band" />
          </Cell>
          <Cell>
            <Stat value={copy.habits.splitValue(o.weekdayDrives, o.weekendDrives)} label={copy.habits.split} testID="wrapped-split" />
          </Cell>
        </Grid>
      ) : null}
    </Body>
  );
}

function PlacesSlide({ v }: { v: StoryView }) {
  const p = v.places;
  if (!p?.pair) return null;
  return (
    <Body>
      <SlideTitle>{copy.places.title}</SlideTitle>
      <Stat
        big
        value={`${p.pair.from} → ${p.pair.to}`}
        label={copy.places.most}
        sub={copy.places.drives(p.pair.drives)}
        testID="wrapped-trip"
      />
      {p.commuteDrives > 0 ? (
        <Text variant="title3" style={{ color: WHITE }} testID="wrapped-commute">
          {copy.places.commute(p.commuteDrives)}
        </Text>
      ) : null}
    </Body>
  );
}

function ProgressSlide({ v }: { v: StoryView }) {
  const t = useTheme();
  const titles = v.core.badges.map((id) => ACHIEVEMENTS.find((a) => a.id === id)?.title).filter((x): x is string => typeof x === 'string');
  const goals = v.own?.goalsCompleted ?? 0;
  return (
    <Body>
      <SlideTitle>{copy.progress.title}</SlideTitle>
      {v.badgesCount > 0 ? (
        <View style={{ gap: t.space.sm }} testID="wrapped-badges">
          <Text variant="title2" style={{ color: WHITE }}>
            {copy.progress.badges(v.badgesCount)}
          </Text>
          {titles.length > 0 ? (
            <Text variant="body" style={{ color: SOFT }}>
              {titles.join(' · ')}
            </Text>
          ) : null}
        </View>
      ) : null}
      {goals > 0 ? (
        <Text variant="title2" style={{ color: WHITE }} testID="wrapped-goals">
          {copy.progress.goals(goals)}
        </Text>
      ) : null}
    </Body>
  );
}

function ArchetypeSlide({ v }: { v: StoryView }) {
  const t = useTheme();
  const a = v.core.archetype;
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: t.space.lg }}>
      <Text variant="label" style={{ color: SOFT, textAlign: 'center' }}>
        {v.yours ? copy.archetype.ownKicker : copy.archetype.sharedKicker}
      </Text>
      <ArchetypeIcon pattern={archetypePattern(a)} size={140} disc={withAlpha(WHITE, 0.16)} testID="wrapped-archetype-icon" />
      <Text variant="title1" style={{ color: WHITE, textAlign: 'center' }} accessibilityRole="header" testID="wrapped-archetype-name">
        {archetypeName(a)}
      </Text>
      <Text variant="body" style={{ color: SOFT, textAlign: 'center' }} testID="wrapped-archetype-line">
        {archetypeDescription(a)}
      </Text>
    </View>
  );
}

/** A slide's content by id (the summary is the screen's own: it holds the share). */
export function slideNode(id: Exclude<SlideId, 'summary'>, v: StoryView): ReactNode {
  switch (id) {
    case 'intro':
      return <IntroSlide v={v} />;
    case 'totals':
      return <TotalsSlide v={v} />;
    case 'safety':
      return <SafetySlide v={v} />;
    case 'smoothness':
      return <SmoothnessSlide v={v} />;
    case 'phoneSpeed':
      return <PhoneSpeedSlide v={v} />;
    case 'habits':
      return <HabitsSlide v={v} />;
    case 'places':
      return <PlacesSlide v={v} />;
    case 'progress':
      return <ProgressSlide v={v} />;
    case 'archetype':
      return <ArchetypeSlide v={v} />;
  }
}

import { useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { ThemeProvider, useTheme } from '../theme';
import type { LeagueTier, Signal, TypeVariant } from '../tokens';
import { Avatar } from '../primitives/Avatar';
import { Banner } from '../primitives/Banner';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { Divider } from '../primitives/Divider';
import { EmptyState } from '../primitives/EmptyState';
import { FreezeCount } from '../primitives/FreezeCount';
import { IconButton } from '../primitives/IconButton';
import { ListRow } from '../primitives/ListRow';
import { Pill } from '../primitives/Pill';
import { PointsCounter } from '../primitives/PointsCounter';
import { ProgressBar } from '../primitives/ProgressBar';
import { ProgressRing } from '../primitives/ProgressRing';
import { Screen, ScreenTitle } from '../primitives/Screen';
import { SectionHeader } from '../primitives/SectionHeader';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { Sheet } from '../primitives/Sheet';
import { Skeleton } from '../primitives/Skeleton';
import { StatTile } from '../primitives/StatTile';
import { StreakFlame } from '../primitives/StreakFlame';
import { Text } from '../primitives/Text';
import { TIER_ORDER, TierBadge } from '../primitives/TierBadge';
import { ToggleRow } from '../primitives/ToggleRow';
import { TrendArrow } from '../primitives/TrendArrow';
import type { SkyMood } from '../sky/palette';
import type { SkyPhase } from '../sky/phase';
import { SkyBackdrop } from '../sky/SkyBackdrop';
import type { WeatherKind } from '../sky/weather';

const TYPE_RAMP: TypeVariant[] = [
  'hero',
  'display',
  'stat',
  'title1',
  'title2',
  'title3',
  'headline',
  'body',
  'callout',
  'subhead',
  'footnote',
  'caption',
  'label',
];
const SIGNALS: Signal[] = ['clean', 'minor', 'moderate', 'severe'];
const SIGNAL_GLYPH = {
  clean: 'checkmark-circle',
  minor: 'alert-circle',
  moderate: 'warning',
  severe: 'close-circle',
} as const;
const NAMES = ['maya_drives', 'LurpDaDerp', 'jordan', 'sam.k', 'alex-15', 'dana77', 'rio', 'quinn_t'];

function Section({ title, children }: { title: string; children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.md }}>
      <SectionHeader title={title} />
      {children}
    </View>
  );
}

function Row({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm, alignItems: 'center' }}>
      {children}
    </View>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: 4, width: 64 }}>
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 12,
          backgroundColor: color,
          borderWidth: 1,
          borderColor: t.colors.border,
        }}
      />
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function Body() {
  const t = useTheme();
  const [filter, setFilter] = useState<'clean' | 'negative' | null>('clean');
  const [board, setBoard] = useState<'friends' | 'league' | 'global'>('friends');
  const [points, setPoints] = useState(1240);
  const [streak, setStreak] = useState(11);
  const [voice, setVoice] = useState(false);
  const [sheet, setSheet] = useState(false);

  return (
    <>
      <Section title="Type">
        {TYPE_RAMP.map((v) => (
          <Text key={v} variant={v} numberOfLines={1}>
            {v === 'hero' || v === 'display' || v === 'stat' ? `${v} 1,240` : `${v} Drive clean`}
          </Text>
        ))}
      </Section>

      <Section title="Colour">
        <Row>
          <Swatch color={t.colors.bg} label="bg" />
          <Swatch color={t.colors.surface} label="surface" />
          <Swatch color={t.colors.surfaceRaised} label="raised" />
          <Swatch color={t.colors.primary} label="primary" />
          <Swatch color={t.colors.accent} label="accent" />
          <Swatch color={t.colors.freeze} label="freeze" />
        </Row>
        <Row>
          {SIGNALS.map((s) => (
            <Swatch key={s} color={t.colors.signal[s].fill} label={s} />
          ))}
        </Row>
        <Row>
          {SIGNALS.map((s) => (
            <Pill key={s} label={s} tone={s} icon={SIGNAL_GLYPH[s]} />
          ))}
        </Row>
        <Row>
          {SIGNALS.map((s) => (
            <Pill key={s} label={s} tone={s} icon={SIGNAL_GLYPH[s]} emphasis="solid" />
          ))}
        </Row>
      </Section>

      <Section title="Buttons">
        <Button label="Start drive" icon="car-sport" onPress={() => {}} />
        <Button label="Secondary" variant="secondary" size="md" onPress={() => {}} />
        <Row>
          <Button label="Ghost" variant="ghost" size="sm" onPress={() => {}} />
          <Button label="Small" variant="secondary" size="sm" onPress={() => {}} />
          <Button label="Loading" size="sm" loading onPress={() => {}} />
          <Button label="Disabled" size="sm" disabled onPress={() => {}} />
        </Row>
        <Button label="Delete account" variant="destructive" size="md" onPress={() => {}} />
        <Row>
          <IconButton icon="share-outline" accessibilityLabel="Share" onPress={() => {}} />
          <IconButton icon="qr-code" accessibilityLabel="My QR code" variant="tinted" onPress={() => {}} />
          <IconButton icon="add" accessibilityLabel="Add friend" variant="filled" onPress={() => {}} />
        </Row>
      </Section>

      <Section title="Chips and segments">
        <Row>
          <Chip label="Clean" selected={filter === 'clean'} onPress={() => setFilter(filter === 'clean' ? null : 'clean')} />
          <Chip
            label="Negative"
            selected={filter === 'negative'}
            onPress={() => setFilter(filter === 'negative' ? null : 'negative')}
          />
        </Row>
        <SegmentedControl
          accessibilityLabel="Leaderboard"
          segments={[
            { value: 'friends', label: 'Friends & clan' },
            { value: 'league', label: 'League' },
            { value: 'global', label: 'Global' },
          ]}
          value={board}
          onChange={setBoard}
        />
      </Section>

      <Section title="Cards">
        <Card variant="hero">
          <Text variant="label" tone="muted">
            Safety Rating
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
            <Text variant="hero">92</Text>
            <TrendArrow direction="up" better="up" />
          </View>
          <View style={{ flexDirection: 'row', gap: t.space.lg, flexWrap: 'wrap', alignItems: 'center' }}>
            <StreakFlame count={streak} multiplier={1 + Math.min(0.3, streak * 0.02)} />
            <FreezeCount count={2} />
            <TierBadge tier="gold" rank={4} />
          </View>
          <ProgressBar value={0.62} accessibilityLabel="Level 7 progress" />
        </Card>
        <Card>
          <Text variant="title3">Plain card</Text>
          <Text variant="subhead" tone="muted">
            Paper white with a soft shadow in light; charcoal with a hairline in dark.
          </Text>
        </Card>
        <Card variant="raised">
          <Text variant="headline">Raised card</Text>
        </Card>
        <Card variant="outline" onPress={() => {}} accessibilityLabel="Add a privacy zone">
          <Text variant="headline" tone="accent">
            + Add a privacy zone
          </Text>
        </Card>
      </Section>

      <Section title="Stats">
        <Card>
          <View style={{ flexDirection: 'row', gap: t.space.lg }}>
            <StatTile label="Speeding" value="0.8" unit="per 100 mi" health="green" trend="down" style={{ flex: 1 }} />
            <StatTile label="Phone pickups" value="1.4" unit="per 100 mi" health="red" trend="up" style={{ flex: 1 }} />
          </View>
          <Divider />
          <View style={{ flexDirection: 'row', gap: t.space.lg }}>
            <StatTile label="Harsh driving" value="6.1" unit="per 100 mi" health="yellow" trend="flat" style={{ flex: 1 }} />
            <StatTile label="Clean drives" value="84" unit="%" health="green" trend="up" higherIsBetter style={{ flex: 1 }} />
          </View>
        </Card>
        <StatTile label="Miles" value="312" unit="mi" framed />
      </Section>

      <Section title="Points and streak">
        <PointsCounter value={points} size="hero" label="Points" />
        <Row>
          <Button label="+167" size="sm" variant="secondary" onPress={() => setPoints((p) => p + 167)} />
          <Button label="−44" size="sm" variant="secondary" onPress={() => setPoints((p) => p - 44)} />
          <Button label="Streak +1" size="sm" variant="secondary" onPress={() => setStreak((s) => s + 1)} />
        </Row>
        <PointsCounter value={-44} from={0} signed size="display" label="Points earned" />
        <StreakFlame count={streak} multiplier={1.22} size="lg" />
        <StreakFlame count={3} state="atRisk" />
        <StreakFlame count={7} state="frozen" />
        <StreakFlame count={0} />
        <FreezeCount count={1} showNumber />
      </Section>

      <Section title="Progress">
        <ProgressBar value={0.35} tone="clean" accessibilityLabel="Challenge progress" />
        <ProgressBar value={0.7} tone="moderate" height={6} accessibilityLabel="Thin bar" />
        <Row>
          <ProgressRing value={0.68} accessibilityLabel="Clan goal" accessibilityValueText="340 of 500 clean miles">
            <Text variant="stat">68%</Text>
          </ProgressRing>
          <ProgressRing value={0.4} size={56} tone="clean" accessibilityLabel="Challenge">
            <Text variant="label">2/5</Text>
          </ProgressRing>
          <ProgressRing value={0} size={56} accessibilityLabel="Empty ring" />
        </Row>
      </Section>

      <Section title="Avatars and tiers">
        <Row>
          {NAMES.map((n) => (
            <Avatar key={n} username={n} />
          ))}
        </Row>
        <Row>
          <Avatar username="maya_drives" size="xl" tier="diamond" accessibilityLabel="maya_drives" />
          <Avatar username="LurpDaDerp" size="lg" tier="gold" />
          <Avatar username="jordan" size="sm" />
        </Row>
        {TIER_ORDER.map((tier: LeagueTier) => (
          <TierBadge key={tier} tier={tier} />
        ))}
        <Row>
          {TIER_ORDER.map((tier) => (
            <TierBadge key={tier} tier={tier} size="sm" showLabel={false} />
          ))}
        </Row>
        <TierBadge tier="platinum" size="lg" rank={2} />
      </Section>

      <Section title="Lists">
        <Card padded={false}>
          <ListRow
            title="Tue 7:42 AM · Home → School"
            subtitle="6.2 mi · 14 min"
            leading={<Avatar username="maya_drives" size="sm" />}
            trailing={<Pill label="+82" tone="clean" icon="checkmark-circle" />}
            onPress={() => {}}
          />
          <Divider inset={16} />
          <ListRow
            title="Mon 4:10 PM · School → Home"
            subtitle="5.9 mi · 2 events"
            trailing={<Pill label="−20" tone="severe" icon="close-circle" />}
            onPress={() => {}}
          />
          <Divider inset={16} />
          <ToggleRow title="Voice alerts" subtitle="Speak a short line with each alert" icon="volume-high" value={voice} onValueChange={setVoice} />
        </Card>
      </Section>

      <Section title="Feedback">
        <Banner tone="info" message="Location is set to While Using. That's all RoadWise needs." />
        <Banner tone="warning" message="Motion access is off." action={{ label: 'Fix', onPress: () => {} }} />
        <Banner tone="danger" message="Couldn't sync. We'll retry when you're online." />
        <Banner tone="success" message="Freeze earned for 5 clean drives." />
        <Card>
          <EmptyState
            icon="car-sport"
            title="Take your first drive"
            body="Safe miles earn points. Streaks multiply them."
            action={{ label: 'Start drive', onPress: () => {} }}
          />
        </Card>
        <View style={{ gap: t.space.sm }}>
          <Skeleton width="60%" height={20} />
          <Skeleton width="100%" height={56} radius={t.radius.lg} />
        </View>
        <Button label="Open sheet" variant="secondary" size="md" onPress={() => setSheet(true)} />
        <Sheet visible={sheet} onClose={() => setSheet(false)} title="Report this event">
          <Text variant="subhead" tone="muted">
            Pick what happened. Braked for a hazard is accepted right away, up to 3 times a week.
          </Text>
          <Button label="Braked for a hazard" variant="secondary" size="md" onPress={() => setSheet(false)} />
          <Button label="Wasn't driving" variant="secondary" size="md" onPress={() => setSheet(false)} />
        </Sheet>
      </Section>
    </>
  );
}

const PHASES: SkyPhase[] = ['night', 'dawn', 'day', 'dusk'];
const KINDS: WeatherKind[] = ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm'];

/**
 * A window onto the top of a tab screen for the mood picked above: the page sky with its weather,
 * the title and a line in the white sky ink, a paper pill, and a scene card.
 */
function SkyPreview() {
  const t = useTheme();
  return (
    <View style={{ height: 320, borderRadius: t.radius.card, borderCurve: 'continuous', overflow: 'hidden', borderWidth: 1, borderColor: t.colors.border }}>
      <SkyBackdrop height={320} front={false} />
      <View style={{ padding: t.space.lg, gap: t.space.md }}>
        <ScreenTitle onSky trailing={<Avatar username="maya" size="md" />}>
          Hey, maya
        </ScreenTitle>
        <Text variant="subhead" tone="onSkyMuted">
          3-day streak. Drive today to keep it.
        </Text>
        <Card variant="hero" style={{ minHeight: 150 }}>
          <Text variant="label" tone="muted">
            Level
          </Text>
          <Text variant="display">7</Text>
        </Card>
      </View>
    </View>
  );
}

/**
 * Every primitive in one scroll, under a light/dark switch, a reduce-motion switch and a sky
 * picker (any time of day with any weather, blended as the live app blends it). Reached at
 * `/(app)/dev/ui` in development and diagnostics builds only.
 */
export function UiGallery({ initialScheme = 'light' }: { initialScheme?: 'light' | 'dark' }) {
  const [scheme, setScheme] = useState<'light' | 'dark'>(initialScheme);
  const [still, setStill] = useState(false);
  const [phase, setPhase] = useState<SkyPhase | null>(null);
  const [kind, setKind] = useState<WeatherKind>('clear');
  const mood: SkyMood | null = phase ? { phase, glow: phase === 'dawn' || phase === 'dusk' ? 1 : 0, weather: { kind, intensity: 'moderate' } } : null;

  return (
    <ThemeProvider scheme={mood ? undefined : scheme} mood={mood} reduceMotion={still}>
      <Screen scroll>
        <Text variant="title1" accessibilityRole="header">
          Design system
        </Text>
        <SegmentedControl
          accessibilityLabel="Theme"
          segments={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          value={scheme}
          onChange={(s) => {
            setPhase(null);
            setScheme(s);
          }}
        />
        <Chip label="Reduce motion" role="switch" selected={still} onPress={() => setStill(!still)} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {PHASES.map((p) => (
            <Chip key={p} label={p} selected={phase === p} onPress={() => setPhase(phase === p ? null : p)} />
          ))}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {KINDS.map((k) => (
            <Chip key={k} label={k} selected={kind === k} onPress={() => setKind(k)} />
          ))}
        </View>
        <SkyPreview />
        <Body />
      </Screen>
    </ThemeProvider>
  );
}

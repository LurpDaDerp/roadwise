import { useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { ThemeProvider, useTheme } from '../theme';
import type { Signal, TypeVariant } from '../tokens';
import { Avatar } from '../primitives/Avatar';
import { Banner } from '../primitives/Banner';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { CountUp } from '../primitives/CountUp';
import { Divider } from '../primitives/Divider';
import { EmptyState } from '../primitives/EmptyState';
import { IconButton } from '../primitives/IconButton';
import { ListRow } from '../primitives/ListRow';
import { MeritIcon } from '../primitives/MeritIcon';
import { Pill } from '../primitives/Pill';
import { ProgressBar } from '../primitives/ProgressBar';
import { ProgressRing } from '../primitives/ProgressRing';
import { Screen, ScreenTitle } from '../primitives/Screen';
import { SectionHeader } from '../primitives/SectionHeader';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { Sheet } from '../primitives/Sheet';
import { Skeleton } from '../primitives/Skeleton';
import { StatTile } from '../primitives/StatTile';
import { Text } from '../primitives/Text';
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
  const [filter, setFilter] = useState<'clean' | 'passenger' | null>('clean');
  const [period, setPeriod] = useState<'week' | 'month' | 'all'>('week');
  const [score, setScore] = useState(92);
  const [voice, setVoice] = useState(false);
  const [sheet, setSheet] = useState(false);

  return (
    <>
      <Section title="Type">
        {TYPE_RAMP.map((v) => (
          <Text key={v} variant={v} numberOfLines={1}>
            {v === 'hero' || v === 'display' || v === 'stat' ? `${v} 92` : `${v} Drive clean`}
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
            label="Passenger"
            selected={filter === 'passenger'}
            onPress={() => setFilter(filter === 'passenger' ? null : 'passenger')}
          />
        </Row>
        <SegmentedControl
          accessibilityLabel="Period"
          segments={[
            { value: 'week', label: 'Week' },
            { value: 'month', label: 'Month' },
            { value: 'all', label: 'All time' },
          ]}
          value={period}
          onChange={setPeriod}
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
          <ProgressBar value={0.62} accessibilityLabel="Weekly goals progress" />
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
            <StatTile label="Speeding events" value="1" health="green" trend="down" style={{ flex: 1 }} />
            <StatTile label="Hard brakes" value="4" health="red" trend="up" style={{ flex: 1 }} />
          </View>
          <Divider />
          <View style={{ flexDirection: 'row', gap: t.space.lg }}>
            <StatTile label="Harsh driving" value="6" health="yellow" trend="flat" style={{ flex: 1 }} />
            <StatTile label="Clean drives" value="84" unit="%" health="green" trend="up" higherIsBetter style={{ flex: 1 }} />
          </View>
        </Card>
        <StatTile label="Miles" value="312" unit="mi" framed />
      </Section>

      <Section title="Drive score and merit">
        <CountUp value={score} from={0} size="hero" suffix="/100" label="Drive score" />
        <Row>
          <Button label="Score 74" size="sm" variant="secondary" onPress={() => setScore(74)} />
          <Button label="Score 98" size="sm" variant="secondary" onPress={() => setScore(98)} />
        </Row>
        {/* The five merit shapes, lowest to highest (their inks are the recap's, per surface). */}
        <Row>
          {MERIT_TIERS.map((tier) => (
            <MeritIcon key={tier} tier={tier} color={t.colors.text} size={28} testID={`gallery-merit-${tier}`} />
          ))}
        </Row>
      </Section>

      <Section title="Progress">
        <ProgressBar value={0.35} tone="clean" accessibilityLabel="Challenge progress" />
        <ProgressBar value={0.7} tone="moderate" height={6} accessibilityLabel="Thin bar" />
        <Row>
          <ProgressRing value={0.68} accessibilityLabel="Weekly goal" accessibilityValueText="34 of 50 clean miles">
            <Text variant="stat">68%</Text>
          </ProgressRing>
          <ProgressRing value={0.4} size={56} tone="clean" accessibilityLabel="Challenge">
            <Text variant="label">2/5</Text>
          </ProgressRing>
          <ProgressRing value={0} size={56} accessibilityLabel="Empty ring" />
        </Row>
      </Section>

      <Section title="Avatars">
        <Row>
          {NAMES.map((n) => (
            <Avatar key={n} username={n} />
          ))}
        </Row>
        <Row>
          <Avatar username="maya_drives" size="xl" accessibilityLabel="maya_drives" />
          <Avatar username="LurpDaDerp" size="lg" />
          <Avatar username="jordan" size="sm" />
        </Row>
      </Section>

      <Section title="Lists">
        <Card padded={false}>
          <ListRow
            title="Tue 7:42 AM · Home → School"
            subtitle="6.2 mi · 14 min"
            leading={<Avatar username="maya_drives" size="sm" />}
            trailing={<Pill label="96" tone="clean" icon="checkmark-circle" />}
            onPress={() => {}}
          />
          <Divider inset={16} />
          <ListRow
            title="Mon 4:10 PM · School → Home"
            subtitle="5.9 mi · 2 events"
            trailing={<Pill label="71" tone="severe" icon="close-circle" />}
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
        <Banner tone="success" message="Badge unlocked: Clean 100." />
        <Card>
          <EmptyState
            icon="car-sport"
            title="Take your first drive"
            body="Every drive gets a score out of 100."
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

const MERIT_TIERS = [1, 2, 3, 4, 5] as const;
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
          2 of 3 weekly goals done.
        </Text>
        <Card variant="hero" style={{ minHeight: 150 }}>
          <Text variant="label" tone="muted">
            Safety Rating
          </Text>
          <Text variant="display">92</Text>
        </Card>
      </View>
    </View>
  );
}

/**
 * Every primitive in one scroll, under a Light / Dark switch (the static looks of Settings ›
 * Appearance), a reduce-motion switch and a sky picker (Adaptive: any time of day with any
 * weather, blended as the live app blends it). Reached at `/(app)/dev/ui` in development and
 * diagnostics builds only.
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

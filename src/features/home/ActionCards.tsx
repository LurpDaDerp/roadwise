import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import type { LocalDrive } from '@/features/drives/model';
import { LEVEL_ICON, LEVEL_LABEL, LEVEL_TONE, type Coaching, type Level } from '@/features/analytics/model';
import { Card, FreezeCount, IconButton, Text, useTheme, withAlpha } from '@/ui';

/** What the latest drive did to the streak, when Home should say so. */
export type StreakNews = { clientTripId: string; outcome: 'reset' | 'freeze_used' };

/**
 * The latest kept drive's streak news: the streak was lost, or a freeze saved it. Only the newest
 * drive the server has answered for counts ("wasn't driving" and merged drives never do), so a
 * later drive that grew the streak takes the news down.
 */
export function latestStreakNews(drives: readonly LocalDrive[]): StreakNews | null {
  const latest = drives.find((d) => d.result !== null && d.status !== 'not_driving' && d.status !== 'merged');
  const outcome = latest?.result?.streak.outcome;
  if (!latest || (outcome !== 'reset' && outcome !== 'freeze_used')) return null;
  return { clientTripId: latest.clientTripId, outcome };
}

/** "2 freezes left", "1 freeze left", "No freezes left". */
export function freezesLeft(n: number): string {
  const held = Math.max(0, Math.floor(n));
  if (held === 0) return 'No freezes left';
  return `${held} ${held === 1 ? 'freeze' : 'freezes'} left`;
}

export const STREAK_TITLE: Record<StreakNews['outcome'], string> = {
  reset: 'Streak lost',
  freeze_used: 'A freeze saved your streak',
};

/** The round icon at the left of an action card. */
function IconDisc({ name, color, background }: { name: keyof typeof Ionicons.glyphMap; color: string; background: string }) {
  const t = useTheme();
  return (
    <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: background }}>
      <Ionicons name={name} size={t.size.iconLg} color={color} accessible={false} />
    </View>
  );
}

/**
 * The streak card under the drive card after a drive lost the streak or spent a freeze on it,
 * with the freezes still held. Its ✕ puts it away for that drive.
 */
export function StreakCard({ outcome, freezes, onDismiss }: { outcome: StreakNews['outcome']; freezes: number; onDismiss: () => void }) {
  const t = useTheme();
  const saved = outcome === 'freeze_used';
  return (
    <Card padded={false} testID="home-streak-card">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.lg, paddingRight: t.space.xs }}>
        <IconDisc
          name={saved ? 'snow' : 'flame-outline'}
          color={saved ? t.colors.freeze : t.colors.textMuted}
          background={saved ? withAlpha(t.colors.freeze, 0.14) : t.colors.surfaceRaised}
        />
        <View style={{ flex: 1, gap: t.space.xs }}>
          <Text variant="headline" testID="home-streak-card-title">
            {STREAK_TITLE[outcome]}
          </Text>
          <View
            accessible
            accessibilityLabel={freezesLeft(freezes)}
            style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: t.space.sm }}
          >
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <FreezeCount count={freezes} testID="home-streak-card-freezes" />
            </View>
            <Text variant="subhead" tone="muted" testID="home-streak-card-left">
              {freezesLeft(freezes)}
            </Text>
          </View>
        </View>
        <IconButton
          icon="close"
          accessibilityLabel="Hide streak news"
          accessibilityHint="Hides the news from this drive."
          onPress={onDismiss}
          testID="home-streak-card-dismiss"
        />
      </View>
    </Card>
  );
}

const FAINT: Record<Level, 'successFaint' | 'warningFaint' | 'dangerFaint'> = { good: 'successFaint', fair: 'warningFaint', poor: 'dangerFaint' };

/**
 * The coaching tip: the 30-day level's icon at the left, the weakest area's title and one line of
 * advice. Only for a Fair or Poor level; one tap opens Analytics.
 */
export function CoachTipCard({ coaching, onOpen }: { coaching: Coaching & { level: Level }; onOpen: () => void }) {
  const t = useTheme();
  const { level } = coaching;
  return (
    <Card
      onPress={onOpen}
      accessibilityLabel={`${LEVEL_LABEL[level]}. ${coaching.title}. ${coaching.tip}`}
      accessibilityHint="Opens Analytics"
      testID="home-tip"
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <View testID={`home-tip-${level}`}>
          <IconDisc name={LEVEL_ICON[level]} color={t.colors[LEVEL_TONE[level]]} background={t.colors[FAINT[level]]} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="headline">{coaching.title}</Text>
          <Text variant="subhead" tone="muted">
            {coaching.tip}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={t.size.icon} color={t.colors.textSubtle} accessible={false} />
      </View>
    </Card>
  );
}

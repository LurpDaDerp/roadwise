import { Ionicons } from '@expo/vector-icons';

import { Card, ListRow, useTheme } from '@/ui';

import type { BadgeDef, EarnedBadge, Progress } from '../api';
import { FAMILY_GLYPH } from '../badges/BadgeSeal';
import { badgesCopy } from '../copy/badges';
import { hubCopy as copy } from '../copy/hub';
import { nextBadge } from '../viewModel';

/** "Next badge: 12 of 30 safe days", or null when every badge is earned. */
export function nextBadgeText(progress: Progress | null, defs: readonly BadgeDef[], earned: readonly EarnedBadge[]) {
  const next = nextBadge(progress, defs, earned);
  if (next === null) return null;
  return { def: next.def, text: copy.nextBadge(badgesCopy.progress(next.current, next.threshold, next.def.metric)) };
}

/** The teaser for the badge closest to being earned → its detail. Hidden when none is left. */
export function NextBadge({
  progress,
  defs,
  earned,
  onOpen,
}: {
  progress: Progress | null;
  defs: readonly BadgeDef[];
  earned: readonly EarnedBadge[];
  onOpen: (badgeId: string) => void;
}) {
  const th = useTheme();
  const next = nextBadgeText(progress, defs, earned);
  if (next === null) return null;
  return (
    <Card padded={false} testID="hub-next-badge">
      <ListRow
        testID="hub-next-badge-row"
        title={next.text}
        leading={<Ionicons name={FAMILY_GLYPH[next.def.family]} size={22} color={th.colors.accent} />}
        onPress={() => onOpen(next.def.id)}
        accessibilityLabel={next.text}
      />
    </Card>
  );
}

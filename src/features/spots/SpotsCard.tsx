import { Fragment } from 'react';
import { View } from 'react-native';

import type { ProblemSpot, SpotsView } from '@/data/queries/spots';
import { EventIcon } from '@/features/drives/EventIcon';
import { Card, Divider, ListRow, Pill, Text, useTheme } from '@/ui';

import { spotsCopy } from './copy';
import { dirWord, gettingBetter, howOften, spotTitle } from './format';
import { spotInk } from './ink';

const c = spotsCopy.card;

/** The kind's icon on a disc of the spot ink: the mark the map's pin carries too. */
export function SpotDisc({ spot, size = 36 }: { spot: Pick<ProblemSpot, 'kind'>; size?: number }) {
  const t = useTheme();
  const ink = spotInk(t.scheme);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="spot-disc"
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: ink.line, alignItems: 'center', justifyContent: 'center' }}
    >
      <EventIcon type={spot.kind} size={size / 2} color={ink.onLine} />
    </View>
  );
}

/** One spot's row: its disc, its street (or direction), what happens and how often, and a pill once it's getting better. */
function SpotRow({ spot, onOpen }: { spot: ProblemSpot; onOpen: (id: string) => void }) {
  const title = spotTitle(spot);
  const kind = spotsCopy.kindTitle[spot.kind];
  const often = howOften(spot);
  const better = gettingBetter(spot);
  return (
    <ListRow
      title={title}
      subtitle={`${kind} · ${often}`}
      leading={<SpotDisc spot={spot} />}
      detail={better ? <Pill tone="clean" icon="checkmark-circle" label={c.gettingBetter} accessible={false} testID={`spot-better-${spot.id}`} /> : undefined}
      accessory="chevron"
      onPress={() => onOpen(spot.id)}
      accessibilityLabel={c.rowLabel(title, kind, dirWord(spot.headingDeg), often, better)}
      accessibilityHint={c.rowHint}
      testID={`spot-row-${spot.id}`}
    />
  );
}

/**
 * "Spots to watch": the places where the same thing keeps happening (at most 5, the most frequent
 * first), each opening its sheet; one calm line when there are none; a footnote for the spots
 * cleared in the last 30 days. Hidden until the spots were computed once, and while the phone has
 * fewer than 10 scored drives in the window and no spot to show.
 */
export function SpotsCard({ view, onOpen }: { view: SpotsView | null; onOpen: (id: string) => void }) {
  const t = useTheme();
  if (view === null || !view.computed || (!view.eligible && view.active.length === 0)) return null;
  return (
    <Card padded={false} testID="spots-card">
      <View style={{ paddingHorizontal: t.space.lg, paddingTop: t.space.lg, paddingBottom: view.active.length > 0 ? t.space.xs : t.space.lg, gap: t.space.xs }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: t.space.md }}>
          <Text variant="title3" accessibilityRole="header">
            {c.title}
          </Text>
          <Text variant="footnote" tone="subtle">
            {c.caption}
          </Text>
        </View>
        {view.active.length === 0 ? (
          <Text variant="subhead" tone="muted" testID="spots-empty">
            {c.empty}
          </Text>
        ) : null}
      </View>
      {view.active.map((spot, i) => (
        <Fragment key={spot.id}>
          {i > 0 ? <Divider inset={t.space.lg} /> : null}
          <SpotRow spot={spot} onOpen={onOpen} />
        </Fragment>
      ))}
      {view.clearedRecently > 0 ? (
        <View style={{ paddingHorizontal: t.space.lg, paddingBottom: t.space.lg, paddingTop: view.active.length > 0 ? t.space.xs : 0 }}>
          {view.active.length > 0 ? <Divider style={{ marginBottom: t.space.md }} /> : null}
          <Text variant="footnote" tone="muted" testID="spots-cleared">
            {c.cleared(view.clearedRecently)}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

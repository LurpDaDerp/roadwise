import { StyleSheet, View } from 'react-native';

import { Card, ListRow, Text, useTheme } from '@/ui';

import type { ChallengeDef, Enrolment } from '../api';
import { CATEGORY_LABEL } from '../copy/common';
import { hubCopy as copy } from '../copy/hub';
import { challengeView } from '../viewModel';

/** How many active challenges the hub lists (there are at most two, §R6). */
export const HUB_CHALLENGES = 2;

/**
 * Up to two active challenges, each one ruled row → its detail. Progress is counted in driving days
 * from settled days only; there is no countdown and nothing to hurry.
 */
export function ActiveChallenges({
  enrolments,
  defs,
  onOpen,
}: {
  enrolments: readonly Enrolment[];
  defs: readonly ChallengeDef[];
  onOpen: (defId: string) => void;
}) {
  const th = useTheme();
  const rows = enrolments
    .filter((e) => e.state === 'active')
    .map((e) => ({ e, def: defs.find((d) => d.id === e.def_id) }))
    .filter((r): r is { e: Enrolment; def: ChallengeDef } => r.def !== undefined)
    .slice(0, HUB_CHALLENGES);
  if (rows.length === 0) return null;
  return (
    <View style={{ gap: th.space.sm }} testID="hub-challenges">
      <Text variant="headline" accessibilityRole="header">
        {copy.challenges.title}
      </Text>
      <Card padded={false}>
        {rows.map(({ e, def }, i) => {
          const view = challengeView(e, def);
          const title = CATEGORY_LABEL[view.predicate];
          const subtitle = copy.challenges.progress(view.pass, view.target);
          return (
            <View
              key={e.id}
              style={{ borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: th.colors.divider }}
            >
              <ListRow
                testID={`hub-challenge-${def.id}`}
                title={title}
                subtitle={subtitle}
                onPress={() => onOpen(def.id)}
              />
            </View>
          );
        })}
      </Card>
    </View>
  );
}

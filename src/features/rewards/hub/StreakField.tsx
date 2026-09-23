import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import { Field, FieldText } from '@/features/trips/Field';
import { Text, useTheme } from '@/ui';

import { hubCopy as copy } from '../copy/hub';
import type { StreakView } from '../viewModel';

/**
 * STREAK: the server's settled streak (`progress.streak_days`, never recomputed from day rows),
 * "days" beside it, the shields held as a glyph and the words "2 shields", and "Best 30" once a
 * streak has restarted. Never "in a row": days without driving sit inside a run.
 */
export function StreakField({ view }: { view: StreakView }) {
  const th = useTheme();
  const best = view.restarted ? view.best : null;
  return (
    <Field label={copy.fields.streak} style={{ flexGrow: 1, flexBasis: 120 }}>
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={copy.streak.spoken(view.days, view.shields, best)}
        testID="hub-streak"
        style={{ gap: th.space.xs }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: th.space.sm, flexWrap: 'wrap' }}>
          <FieldText face="numeral" variant="title1" testID="hub-streak-days">
            {String(view.days)}
          </FieldText>
          <Text variant="subhead">{copy.streak.unit(view.days)}</Text>
        </View>
        {view.shields > 0 ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.xs }} testID="hub-streak-shields">
            <Ionicons name="shield-half-outline" size={16} color={th.colors.accent} />
            <Text variant="footnote">{copy.streak.shields(view.shields)}</Text>
          </View>
        ) : null}
        {best !== null ? (
          <Text variant="footnote" tone="muted" testID="hub-streak-best">
            {copy.streak.best(best)}
          </Text>
        ) : null}
      </View>
    </Field>
  );
}

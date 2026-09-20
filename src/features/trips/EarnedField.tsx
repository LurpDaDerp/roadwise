import { View } from 'react-native';

import { Text, useTheme } from '@/ui';
import { Stamp } from '@/ui/charts';

import { tripCopy as copy } from './copy';
import { Field, FieldText } from './Field';
import type { EarnedKind } from './format';

/**
 * The EARNED field (§7.D D1) before points exist (M5): the day's stamp when the server has
 * confirmed it, otherwise where this drive's score leaves the day — provisional, and it says so.
 */
export function EarnedField({ kind }: { kind: EarnedKind }) {
  const th = useTheme();
  if (kind === 'safeDay') {
    return (
      <Field label={copy.earned.label} testID="earned">
        <View style={{ paddingVertical: th.space.xs }}>
          <Stamp kind="safeDay" testID="stamp-safe-day" />
        </View>
      </Field>
    );
  }
  const text = {
    goodDay: copy.earned.goodDay,
    safeOnTrack: copy.earned.safeOnTrack,
    goodOnTrack: copy.earned.goodOnTrack,
    counts: copy.earned.counts,
  }[kind];
  return (
    <Field label={copy.earned.label} testID="earned">
      <FieldText variant="headline" style={{ fontWeight: '400' }}>
        {text}
      </FieldText>
      {kind === 'goodDay' ? null : (
        <Text variant="footnote" tone="muted">
          {copy.earned.provisional}
        </Text>
      )}
    </Field>
  );
}

import { View } from 'react-native';

import { Field, FieldText } from '@/features/trips/Field';

import { hubCopy as copy } from '../copy/hub';

const format = (n: number) => new Intl.NumberFormat('en-US').format(n);

/**
 * POINTS: the settled lifetime total as the card's largest numeral. A count of progress only —
 * never money, worth or anything to spend (honesty b); the explainer below says so in words.
 */
export function PointsField({ points }: { points: number }) {
  return (
    <Field label={copy.fields.points} style={{ flexGrow: 2, flexBasis: 150 }}>
      <View accessible accessibilityRole="text" accessibilityLabel={copy.points.spoken(points)} testID="hub-points">
        <FieldText face="numeral" variant="display" testID="hub-points-value">
          {format(points)}
        </FieldText>
      </View>
    </Field>
  );
}

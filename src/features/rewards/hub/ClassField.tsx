import { View } from 'react-native';

import { Field, FieldText } from '@/features/trips/Field';
import { Text, useTheme } from '@/ui';

import { hubCopy as copy } from '../copy/hub';
import { ProgressBar } from '../ui/ProgressBar';
import type { ClassView } from '../viewModel';

/**
 * CLASS: the class name, a rule filling towards the next class, and "1,100 to Smooth". Read as one
 * element: "Class Steady, 1,100 points to Smooth". At the top class the rule is full and says so.
 */
export function ClassField({ view }: { view: ClassView }) {
  const th = useTheme();
  const top = view.toNext === null || view.nextName === null;
  const line = top ? copy.class.top : copy.class.toNext(view.toNext as number, view.nextName as string);
  return (
    <Field label={copy.fields.class} style={{ flexGrow: 2, flexBasis: 180 }}>
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={copy.class.spoken(view.name, view.toNext, view.nextName)}
        testID="hub-class"
        style={{ gap: th.space.sm }}
      >
        <FieldText variant="title2" testID="hub-class-name">
          {view.name}
        </FieldText>
        <ProgressBar fraction={view.fraction} testID="hub-class-bar" />
        <Text variant="footnote" tone="muted" testID="hub-class-next">
          {line}
        </Text>
      </View>
    </Field>
  );
}

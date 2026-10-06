import { StyleSheet, View } from 'react-native';

import { Card, Text, useTheme } from '@/ui';

import { onboardingCopy } from '../copy';
import type { StepProps } from '../stepRegistry';
import { StepFrame } from '../StepFrame';

const copy = onboardingCopy.how;

/**
 * The whole game on one screen: safe miles earn, events cost, streaks multiply. Each line leads
 * with its number in the display face, the way the points land after a drive.
 */
export function HowStep({ onNext, onBack }: StepProps) {
  const th = useTheme();
  const tone = ['success', 'danger', 'accent'] as const;
  return (
    <StepFrame
      title={copy.title}
      body={copy.body}
      onBack={onBack}
      primary={{ label: copy.continue, onPress: onNext, testID: 'how-continue' }}
      testID="how-step"
    >
      <Card padded={false}>
        {copy.rows.map((row, i) => (
          <View
            key={row.title}
            accessible
            accessibilityLabel={`${row.title}. ${row.body}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: th.space.lg,
              padding: th.space.lg,
              borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
              borderTopColor: th.colors.divider,
            }}
          >
            <Text variant="stat" tone={tone[i]} style={{ minWidth: 72, textAlign: 'center' }}>
              {row.big}
            </Text>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="headline">{row.title}</Text>
              <Text variant="subhead" tone="muted">
                {row.body}
              </Text>
            </View>
          </View>
        ))}
      </Card>
    </StepFrame>
  );
}

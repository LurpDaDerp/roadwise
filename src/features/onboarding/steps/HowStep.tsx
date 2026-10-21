import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { Card, Text, useTheme } from '@/ui';

import { onboardingCopy } from '../copy';
import type { StepProps } from '../stepRegistry';
import { StepFrame } from '../StepFrame';

const copy = onboardingCopy.how;

/**
 * How RoadWise works, on one screen: how a drive gets recorded (on its own on an iPhone, from Start
 * drive on Android), what to do when someone else drives, the drive score and friends. Each line
 * leads with its icon on an accent disc, as Home's How it works card does.
 */
export function HowStep({ ctx, onNext, onBack }: StepProps) {
  const th = useTheme();
  return (
    <StepFrame
      title={copy.title}
      body={copy.body[ctx.platform]}
      onBack={onBack}
      primary={{ label: copy.continue, onPress: onNext, testID: 'how-continue' }}
      testID="how-step"
    >
      <Card padded={false}>
        {copy.rows[ctx.platform].map((row, i) => (
          <View
            key={row.title}
            accessible
            accessibilityLabel={`${row.title}. ${row.body}`}
            testID={`how-row-${i}`}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: th.space.md,
              padding: th.space.lg,
              borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
              borderTopColor: th.colors.divider,
            }}
          >
            <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: th.colors.accentFaint }}>
              <Ionicons name={row.icon} size={th.size.icon} color={th.colors.accent} />
            </View>
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

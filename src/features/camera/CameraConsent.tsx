// The consent text, drawn the same way on the A10 step and the settings screen: a lead, the points, a footnote.
import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import { Card, Text, useTheme } from '@/ui';

import { cameraConsent } from './copy';

export function CameraConsent({ testID }: { testID?: string }) {
  const th = useTheme();
  return (
    <Card variant="license" testID={testID}>
      <View style={{ gap: th.space.md }}>
        <Text variant="body">{cameraConsent.lead}</Text>
        {cameraConsent.points.map((point) => (
          <View key={point} style={{ flexDirection: 'row', gap: th.space.sm, alignItems: 'flex-start' }}>
            <Ionicons
              name="checkmark"
              size={18}
              color={th.colors.accent}
              style={{ marginTop: 2 }}
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
            <Text variant="callout" style={{ flex: 1 }}>
              {point}
            </Text>
          </View>
        ))}
        <Text variant="footnote" tone="muted">
          {cameraConsent.footnote}
        </Text>
      </View>
    </Card>
  );
}

import { ActivityIndicator, View } from 'react-native';

import { Text, useTheme } from '@/ui';

import { dashpalCopy } from '../../copy';
import { StepTitle } from './StepTitle';

const copy = dashpalCopy.wizard.search;

/** Search mode: looking for a DashPal in pairing mode (up to 15 s). */
export function StepSearch() {
  const th = useTheme();
  return (
    <View style={{ gap: th.space.md, alignItems: 'center', paddingVertical: th.space.lg }}>
      <ActivityIndicator size="large" color={th.colors.accent} accessibilityLabel={copy.title} />
      <StepTitle testID="wizard-search-title">{copy.title}</StepTitle>
      <Text variant="body" tone="muted" style={{ textAlign: 'center' }} testID="wizard-search-body">
        {copy.body}
      </Text>
    </View>
  );
}

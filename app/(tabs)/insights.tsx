import { t } from '@/i18n';
import { Screen, Text } from '@/ui';

export default function Insights() {
  return (
    <Screen>
      <Text variant="title1" accessibilityRole="header">
        {t('tabs.insights')}
      </Text>
    </Screen>
  );
}

import { t } from '@/i18n';
import { Screen, Text } from '@/ui';

export default function Insights() {
  return (
    <Screen bottomInset={false}>
      <Text variant="title1" accessibilityRole="header">
        {t('tabs.insights')}
      </Text>
    </Screen>
  );
}

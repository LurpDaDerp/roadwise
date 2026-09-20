import { t } from '@/i18n';
import { Screen, Text } from '@/ui';

export default function Rewards() {
  return (
    <Screen>
      <Text variant="title1" accessibilityRole="header">
        {t('tabs.rewards')}
      </Text>
    </Screen>
  );
}

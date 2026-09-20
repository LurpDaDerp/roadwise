import { View } from 'react-native';

import { useSession } from '@/data/supabase/session';
import { t } from '@/i18n';
import { Button, Screen, Text } from '@/ui';

/** The licence card itself arrives in M1; for now Home is the proof that the session holds. */
export default function Home() {
  const { signOut } = useSession();

  return (
    <Screen>
      <Text variant="title1" accessibilityRole="header">
        {t('tabs.home')}
      </Text>
      <View style={{ flexGrow: 1 }} />
      <Button label={t('home.signOut')} variant="ghost" onPress={() => void signOut()} />
    </Screen>
  );
}

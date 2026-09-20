import { View } from 'react-native';

import { useSession } from '@/data/supabase/session';
import { LastTripCard } from '@/features/home';
import { t } from '@/i18n';
import { Button, Screen, Text } from '@/ui';

/**
 * The licence card itself arrives in M3; for now Home carries the RECORD row — the last drive,
 * which opens the card back — and the proof that the session holds.
 */
export default function Home() {
  const { signOut } = useSession();

  return (
    <Screen bottomInset={false} scroll>
      <Text variant="title1" accessibilityRole="header">
        {t('tabs.home')}
      </Text>
      <LastTripCard />
      <View style={{ flexGrow: 1 }} />
      <Button label={t('home.signOut')} variant="ghost" onPress={() => void signOut()} />
    </Screen>
  );
}

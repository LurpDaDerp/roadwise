import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';

import { supabase } from '@/data/supabase/client';
import { t } from '@/i18n';
import { Banner, Screen, Text } from '@/ui';

/** Where `roadwise://auth/callback` lands: the PKCE code from the emailed link becomes a session. */
export default function AuthCallback() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const router = useRouter();
  const [exchange, setExchange] = useState<'ok' | 'error' | null>(null);

  useEffect(() => {
    if (!code) return;
    let live = true;
    void supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
      if (live) setExchange(error ? 'error' : 'ok');
    });
    return () => {
      live = false;
    };
  }, [code]);

  // A link with no code is already spent; that is read off the params, not stored in state.
  const state = exchange ?? (code ? 'pending' : 'error');

  if (state === 'error') {
    return (
      <Screen>
        <Banner
          tone="danger"
          message={t('auth.linkInvalid')}
          action={{ label: t('common.retry'), onPress: () => router.replace('/(auth)/sign-in') }}
        />
      </Screen>
    );
  }

  // Exchanging the code is only half of it: the session provider still has to read the profile
  // before anyone counts as signed in. So this screen never navigates — it keeps saying what is
  // happening, and `AuthGate` moves the driver the moment `status` flips.
  return (
    <Screen>
      <Text variant="body" accessibilityLiveRegion="polite">
        {t('auth.signingIn')}
      </Text>
    </Screen>
  );
}

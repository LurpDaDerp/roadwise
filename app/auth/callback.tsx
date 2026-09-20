import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
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

  // The session provider already holds the new session; the launch router decides where it goes.
  if (state === 'ok') return <Redirect href="/" />;

  return (
    <Screen>
      {state === 'error' ? (
        <Banner
          tone="danger"
          message={t('auth.linkInvalid')}
          action={{ label: t('common.retry'), onPress: () => router.replace('/(auth)/sign-in') }}
        />
      ) : (
        <Text variant="body" accessibilityLiveRegion="polite">
          {t('auth.signingIn')}
        </Text>
      )}
    </Screen>
  );
}

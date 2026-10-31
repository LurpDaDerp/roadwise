import type { ErrorBoundaryProps } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { t } from '@/i18n';
import { reportError } from '@/lib/crashReport';
import { Button, Screen, Text, ThemeProvider } from '@/ui';

export const appCrashedCopy = {
  title: 'Something went wrong',
  body: "RoadWise couldn't show this screen. Your drives are safe.",
} as const;

/**
 * The root layout's error boundary (Expo Router's `ErrorBoundary` export): a screen threw while
 * drawing. It stands in for the whole root layout, so it brings its own theme (the phone's scheme)
 * and safe area. The drive host lives outside React, so a drive in progress keeps recording behind
 * it. Try again draws the app again from the root; the error goes to the crash sink once.
 */
export function AppCrashed({ error, retry }: ErrorBoundaryProps) {
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    reportError(error, 'root screen');
  }, [error]);
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <Screen testID="app-crashed">
          <Text variant="title2" accessibilityRole="header">
            {appCrashedCopy.title}
          </Text>
          <Text tone="muted">{appCrashedCopy.body}</Text>
          <View style={{ flexGrow: 1 }} />
          <Button
            label={t('common.retry')}
            loading={retrying}
            disabled={retrying}
            onPress={() => {
              setRetrying(true);
              void retry().finally(() => setRetrying(false));
            }}
            testID="app-crashed-retry"
          />
        </Screen>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

// App.js — providers and the root navigator.
import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Provider as PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';

import RootNavigator from './navigation/RootNavigator';
import { configError } from './utils/firebase';
import { ThemeProvider } from './context/ThemeContext';
import { SettingsProvider } from './context/SettingsContext';
import { AuthProvider } from './context/AuthContext';
import { ErrorBoundary, useTheme } from './theme';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/**
 * Shown instead of the app when the build has no usable Firebase configuration (a
 * cloud build made without the EXPO_PUBLIC_* variables). Rendered before any provider
 * so nothing below tries to use Firebase. Plain colours: the theme is not mounted yet.
 */
function ConfigurationError({ message }) {
  return (
    <View style={{ flex: 1, backgroundColor: '#0b0e10', justifyContent: 'center' }}>
      <ScrollView contentContainerStyle={{ padding: 28 }}>
        <Text style={{ color: '#ff6b6b', fontSize: 20, fontWeight: '800', marginBottom: 14 }}>
          RoadCash is not configured
        </Text>
        <Text style={{ color: '#e6edf3', fontSize: 14, lineHeight: 21 }}>{message}</Text>
      </ScrollView>
    </View>
  );
}

function ThemedStatusBar() {
  const t = useTheme();
  return <StatusBar style={t.isDark ? 'light' : 'dark'} />;
}

export default function App() {
  if (configError) return <ConfigurationError message={configError} />;
  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <ThemeProvider>
            <SettingsProvider>
              <AuthProvider>
                <PaperProvider>
                  <ThemedStatusBar />
                  <RootNavigator />
                </PaperProvider>
              </AuthProvider>
            </SettingsProvider>
          </ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

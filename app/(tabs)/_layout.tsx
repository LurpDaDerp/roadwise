import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { StyleSheet, type ColorValue } from 'react-native';

import { t } from '@/i18n';
import { useTheme } from '@/ui';

type IconName = ComponentProps<typeof Ionicons>['name'];

function tabIcon(name: IconName) {
  return function TabIcon({ color, size }: { color: ColorValue; size: number }) {
    return <Ionicons name={name} size={size} color={color} />;
  };
}

/** The signed-in shell: Home · Leagues · Clan · Profile. Driving is a full-screen flow outside it. */
export default function TabsLayout() {
  const th = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: th.colors.accent,
        tabBarInactiveTintColor: th.colors.textMuted,
        tabBarStyle: {
          backgroundColor: th.colors.surface,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: th.colors.border,
        },
      }}
    >
      <Tabs.Screen name="home" options={{ title: t('tabs.home'), tabBarIcon: tabIcon('home-outline') }} />
      <Tabs.Screen name="leagues" options={{ title: t('tabs.leagues'), tabBarIcon: tabIcon('trophy-outline') }} />
      <Tabs.Screen name="clan" options={{ title: t('tabs.clan'), tabBarIcon: tabIcon('people-outline') }} />
      <Tabs.Screen
        name="profile"
        options={{ title: t('tabs.profile'), tabBarIcon: tabIcon('person-circle-outline') }}
      />
    </Tabs>
  );
}

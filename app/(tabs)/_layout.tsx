import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { StyleSheet, type ColorValue } from 'react-native';

import { t } from '@/i18n';
import { useTheme } from '@/ui';

type IconProps = { color: ColorValue; size: number };

/**
 * The signed-in shell. The centre Drive action lands between Insights and Family in M3, where it
 * mirrors Home's bottom-anchored Start Drive button; until the drive group exists there is nothing
 * for it to open, so the bar stays four even tabs rather than carrying a button that does nothing.
 */
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
      <Tabs.Screen
        name="home"
        options={{
          title: t('tabs.home'),
          tabBarIcon: ({ color, size }: IconProps) => (
            <Ionicons name="card-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="insights"
        options={{
          title: t('tabs.insights'),
          tabBarIcon: ({ color, size }: IconProps) => (
            <Ionicons name="stats-chart-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="family"
        options={{
          title: t('tabs.family'),
          tabBarIcon: ({ color, size }: IconProps) => (
            <Ionicons name="people-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="rewards"
        options={{
          title: t('tabs.rewards'),
          tabBarIcon: ({ color, size }: IconProps) => (
            <Ionicons name="ribbon-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

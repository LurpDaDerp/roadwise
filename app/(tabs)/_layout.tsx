import { Ionicons } from '@expo/vector-icons';
import { Tabs, useIsFocused } from 'expo-router';
import type { ComponentProps } from 'react';
import { View, type ColorValue } from 'react-native';

import { t } from '@/i18n';
import { SkyBackdrop, useTheme } from '@/ui';
import { FloatingTabBar, type FloatingTabBarProps } from '@/ui/nav/FloatingTabBar';

type IconName = ComponentProps<typeof Ionicons>['name'];

function tabIcon(outline: IconName, filled: IconName) {
  return function TabIcon({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) {
    return <Ionicons name={focused ? filled : outline} size={size} color={color} />;
  };
}

/**
 * The signed-in shell: Home · Leagues · Clan · Profile over the page's sky, with the floating
 * pill tab bar. Driving is a full-screen flow outside it (and draws none of the sky). The sky's
 * weather layer runs only while this shell is in front.
 */
export default function TabsLayout() {
  const th = useTheme();
  const focused = useIsFocused();

  return (
    <View style={{ flex: 1, backgroundColor: th.colors.bg }}>
      <SkyBackdrop active={focused} />
      <Tabs
        tabBar={(props) => <FloatingTabBar {...(props as unknown as FloatingTabBarProps)} />}
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: 'transparent' },
        }}
      >
        <Tabs.Screen name="home" options={{ title: t('tabs.home'), tabBarIcon: tabIcon('home-outline', 'home') }} />
        <Tabs.Screen name="leagues" options={{ title: t('tabs.leagues'), tabBarIcon: tabIcon('trophy-outline', 'trophy') }} />
        <Tabs.Screen name="clan" options={{ title: t('tabs.clan'), tabBarIcon: tabIcon('people-outline', 'people') }} />
        <Tabs.Screen
          name="profile"
          options={{ title: t('tabs.profile'), tabBarIcon: tabIcon('person-circle-outline', 'person-circle') }}
        />
      </Tabs>
    </View>
  );
}

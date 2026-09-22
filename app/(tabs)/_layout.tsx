import { Ionicons } from '@expo/vector-icons';
import { Tabs, useRouter, type Href } from 'expo-router';
import {
  Pressable,
  StyleSheet,
  View,
  type ColorValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { t } from '@/i18n';
import { Text, useTheme } from '@/ui';

type IconProps = { color: ColorValue; size: number };

/** The pre-drive sheet (C1, U3). Cast: typed routes are generated at `expo start`. */
export const DRIVE_START_HREF = '/drive/start' as Href;

const DRIVE_TAB_LABEL = t('tabs.drive');
const DRIVE_TAB_HINT = 'Opens the pre-drive sheet';

/**
 * The centre Drive action (§7 navigation: Home · Insights · Drive · Family · Rewards). It never
 * becomes the selected tab: a press opens the pre-drive sheet over the tabs, mirroring Home's
 * bottom-anchored Start drive. If a drive is already running, `/drive/start` itself sends the
 * driver back to Home's in-progress banner (U3).
 */
export function DriveTabButton({
  style,
  testID,
}: {
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const th = useTheme();
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={DRIVE_TAB_LABEL}
      accessibilityHint={DRIVE_TAB_HINT}
      onPress={() => router.push(DRIVE_START_HREF)}
      testID={testID ?? 'drive-tab'}
      style={[style, { alignItems: 'center', justifyContent: 'center' }]}
    >
      {({ pressed }) => (
        <View style={{ alignItems: 'center', gap: 2, opacity: pressed ? 0.85 : 1 }}>
          <View
            style={{
              width: 44,
              height: 32,
              borderRadius: th.radius.pill,
              backgroundColor: th.colors.accent,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="car-sport" size={20} color={th.colors.accentText} />
          </View>
          <Text variant="caption" tone="accent">
            {DRIVE_TAB_LABEL}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/** The signed-in shell: four tabs around the centre Drive action. */
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
        name="drive"
        options={{
          title: DRIVE_TAB_LABEL,
          tabBarButton: ({ style, testID }) => <DriveTabButton style={style} testID={testID} />,
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

import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { withAlpha } from '../sky/color';
import { useTheme } from '../theme';

/** The slice of React Navigation's tab-bar props this bar reads. */
export type FloatingTabBarProps = {
  state: { index: number; routes: readonly { key: string; name: string; params?: object }[] };
  descriptors: Record<
    string,
    {
      options: {
        title?: string;
        tabBarAccessibilityLabel?: string;
        tabBarButtonTestID?: string;
        tabBarIcon?: (p: { focused: boolean; color: string; size: number }) => ReactNode;
      };
    }
  >;
  navigation: {
    emit: (e: { type: 'tabPress' | 'tabLongPress'; target: string; canPreventDefault?: boolean }) => { defaultPrevented?: boolean };
    navigate: (name: string, params?: object) => void;
  };
  insets: { bottom: number };
};

/** The pill's height and the disc that marks the current tab. */
export const TAB_BAR_HEIGHT = 64;
const DISC = 48;
const SIDE = 24;

/**
 * The tab bar: an ink pill floating over the bottom of the page (charcoal in dark), one icon per
 * tab, the current tab on a paper disc that slides between them. Icons only on screen; each tab
 * speaks its name, its role and whether it is selected. It sits in its own band below the
 * screens, with a short fade above it, so no screen needs to pad around it.
 */
export function FloatingTabBar({ state, descriptors, navigation, insets }: FloatingTabBarProps) {
  const t = useTheme();
  const c = t.colors;
  const light = t.scheme === 'light';
  const pill = light ? c.primary : c.surfaceRaised;
  const disc = light ? c.onPrimary : c.primary;
  const onDisc = light ? c.primary : c.onPrimary;
  const idle = light ? '#A9A9B0' : c.textMuted;
  const [width, setWidth] = useState(0);
  const slot = state.routes.length > 0 && width > 0 ? width / state.routes.length : 0;
  const x = useSharedValue(0);
  useEffect(() => {
    if (slot === 0) return;
    const target = state.index * slot + (slot - DISC) / 2;
    x.set(t.reduceMotion ? target : withSpring(target, t.motion.spring.snappy));
  }, [state.index, slot, t.reduceMotion, t.motion.spring.snappy, x]);
  const discStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  return (
    <View style={{ paddingBottom: Math.max(insets.bottom, t.space.md), paddingTop: t.space.sm, paddingHorizontal: SIDE }}>
      {/* A short fade so content scrolling under the band dissolves instead of being cut. */}
      <LinearGradient
        pointerEvents="none"
        colors={[withAlpha(c.bg, 0), c.bg]}
        style={{ position: 'absolute', left: 0, right: 0, top: -20, height: 28 }}
      />
      <View
        accessibilityRole="tablist"
        onLayout={(e) => setWidth(e.nativeEvent.layout.width - 16)}
        style={{
          height: TAB_BAR_HEIGHT,
          borderRadius: TAB_BAR_HEIGHT / 2,
          borderCurve: 'continuous',
          backgroundColor: pill,
          borderWidth: light ? 0 : 1,
          borderColor: c.border,
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 8,
          boxShadow: light ? '0px 10px 30px rgba(17, 17, 19, 0.22)' : '0px 10px 30px rgba(0, 0, 0, 0.5)',
        }}
      >
        {slot > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[{ position: 'absolute', left: 8, top: (TAB_BAR_HEIGHT - DISC) / 2, width: DISC, height: DISC, borderRadius: DISC / 2, backgroundColor: disc }, discStyle]}
          />
        ) : null}
        {state.routes.map((route, i) => {
          const focused = state.index === i;
          const o = descriptors[route.key]?.options ?? {};
          const label = o.title ?? route.name;
          const onPress = () => {
            const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !e.defaultPrevented) navigation.navigate(route.name, route.params);
          };
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityLabel={o.tabBarAccessibilityLabel ?? label}
              accessibilityState={{ selected: focused }}
              testID={o.tabBarButtonTestID ?? `tab-${route.name}`}
              onPress={onPress}
              onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
              style={({ pressed }) => ({ flex: 1, height: TAB_BAR_HEIGHT, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
            >
              {o.tabBarIcon?.({ focused, color: focused ? onDisc : idle, size: 22 })}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

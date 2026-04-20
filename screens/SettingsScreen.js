import React, { useRef, useCallback } from 'react';
import { View, Text, Pressable, Animated, Easing, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import {
  Screen,
  Section,
  Card,
  ScreenHeader,
  useTheme,
} from '../theme';

const CATEGORIES = [
  { title: 'General',  subtitle: 'Appearance & preferences', route: 'GeneralSettings',     icon: 'options-outline' },
  { title: 'Safety',   subtitle: 'Trusted contacts & alerts', route: 'SafetySettings',     icon: 'shield-checkmark-outline' },
  { title: 'Driving',  subtitle: 'Drive tracking behavior',   route: 'DriveScreenSettings', icon: 'speedometer-outline' },
  { title: 'Account',  subtitle: 'Profile, photo, password',  route: 'AccountSettings',    icon: 'person-outline' },
];

export default function SettingsScreen() {
  const navigation = useNavigation();
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const t = useTheme();

  useFocusEffect(
    useCallback(() => {
      contentOpacity.setValue(0);
      Animated.timing(contentOpacity, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.poly(3)),
        useNativeDriver: true,
      }).start();
    }, [contentOpacity])
  );

  return (
    <Screen>
      <Animated.View style={{ flex: 1, opacity: contentOpacity }}>
        <ScreenHeader eyebrow="Menu" title="Settings" subtitle="Tune RoadCash to fit you." />

        <Section label="Categories">
          <Card padded={false}>
            {CATEGORIES.map((item, i) => (
              <Pressable
                key={item.route}
                onPress={() => navigation.navigate(item.route)}
                android_ripple={{ color: t.colors.accentFaint }}
                style={({ pressed }) => [
                  {
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 16,
                    paddingHorizontal: 18,
                    borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                    borderTopColor: t.colors.divider,
                    opacity: pressed ? 0.85 : 1,
                  },
                ]}
              >
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    backgroundColor: t.colors.accentFaint,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: 14,
                  }}
                >
                  <Ionicons name={item.icon} size={20} color={t.colors.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[t.typography.subheading, { color: t.colors.text }]}>
                    {item.title}
                  </Text>
                  <Text
                    style={[
                      t.typography.caption,
                      { color: t.colors.textMuted, marginTop: 2 },
                    ]}
                  >
                    {item.subtitle}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={t.colors.textSubtle} />
              </Pressable>
            ))}
          </Card>
        </Section>
      </Animated.View>
    </Screen>
  );
}

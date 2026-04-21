import React, { useEffect, useContext } from 'react';
import { View, Text, ScrollView } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import { ThemeContext } from '../context/ThemeContext';
import { Screen, Section, Card, ScreenHeader, useTheme } from '../theme';

const STORAGE_KEYS = {
  appTheme: '@appTheme',
};

export default function GeneralSettings() {
  const { theme, updateTheme } = useContext(ThemeContext);
  const t = useTheme();

  const themeSegments = ['Light', 'Dark', 'System'];

  useEffect(() => {
    (async () => {
      try {
        const storedTheme = await AsyncStorage.getItem(STORAGE_KEYS.appTheme);
        if (storedTheme && themeSegments.map((s) => s.toLowerCase()).includes(storedTheme)) {
          updateTheme(storedTheme);
        }
      } catch (e) {
        console.warn('Failed to load settings:', e);
      }
    })();
  }, []);

  const onThemeChange = async (index) => {
    updateTheme(themeSegments[index].toLowerCase());
  };

  return (
    <Screen hasHeader>
      <ScrollView showsVerticalScrollIndicator={false}>
        <ScreenHeader
          align="right"
          eyebrow="Settings · General"
          title="General"
          subtitle="Appearance and interface options."
        />

        <Section label="Appearance">
          <Card>
            <Text
              style={[
                t.typography.subheading,
                { color: t.colors.text, marginBottom: 6 },
              ]}
            >
              Theme
            </Text>
            <Text
              style={[
                t.typography.caption,
                { color: t.colors.textMuted, marginBottom: 16 },
              ]}
            >
              Controls light or dark mode across the app.
            </Text>
            <SegmentedControl
              values={themeSegments}
              selectedIndex={themeSegments.indexOf(
                (theme || 'system').charAt(0).toUpperCase() + (theme || 'system').slice(1)
              )}
              onChange={(event) => onThemeChange(event.nativeEvent.selectedSegmentIndex)}
              appearance={t.isDark ? 'dark' : 'light'}
              tintColor={t.colors.accent}
              style={{ height: 40 }}
            />
          </Card>
        </Section>

        <View style={{ height: 24 }} />
      </ScrollView>
    </Screen>
  );
}

import React, { useState, useEffect } from 'react';
import { View, Text, Switch, ScrollView, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import {
  Screen,
  Section,
  Card,
  ScreenHeader,
  useTheme,
} from '../theme';

const STORAGE_KEYS = {
  speedUnit: '@speedUnit',
  warningsEnabled: '@speedingWarningsEnabled',
  showCurrentSpeed: '@showCurrentSpeed',
  showSpeedLimit: '@showSpeedLimit',
  displayTotalPoints: '@displayTotalPoints',
  distractedNotificationsEnabled: '@distractedNotificationsEnabled',
  audioSpeedUpdatesEnabled: '@audioSpeedUpdatesEnabled',
};

export default function DriveScreenSettings() {
  const t = useTheme();

  const [speedUnit, setSpeedUnit] = useState('mph');
  const [warningsEnabled, setWarningsEnabled] = useState(true);
  const [showCurrentSpeed, setShowCurrentSpeed] = useState(true);
  const [showSpeedLimit, setShowSpeedLimit] = useState(true);
  const [displayTotalPoints, setDisplayTotalPoints] = useState(false);
  const [distractedNotificationsEnabled, setDistractedNotificationsEnabled] = useState(true);
  const [audioSpeedUpdatesEnabled, setAudioSpeedUpdatesEnabled] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const u = await AsyncStorage.getItem(STORAGE_KEYS.speedUnit);
        if (u === 'mph' || u === 'kph') setSpeedUnit(u);
        const a = await AsyncStorage.getItem(STORAGE_KEYS.warningsEnabled);
        if (a !== null) setWarningsEnabled(a === 'true');
        const b = await AsyncStorage.getItem(STORAGE_KEYS.showCurrentSpeed);
        if (b !== null) setShowCurrentSpeed(b === 'true');
        const c = await AsyncStorage.getItem(STORAGE_KEYS.showSpeedLimit);
        if (c !== null) setShowSpeedLimit(c === 'true');
        const d = await AsyncStorage.getItem(STORAGE_KEYS.displayTotalPoints);
        if (d !== null) setDisplayTotalPoints(d === 'true');
        const e = await AsyncStorage.getItem(STORAGE_KEYS.distractedNotificationsEnabled);
        if (e !== null) setDistractedNotificationsEnabled(e === 'true');
        const f = await AsyncStorage.getItem(STORAGE_KEYS.audioSpeedUpdatesEnabled);
        if (f !== null) setAudioSpeedUpdatesEnabled(f === 'true');
      } catch (err) {
        console.warn('Failed to load settings:', err);
      }
    })();
  }, []);

  const onSpeedUnitChange = async (index) => {
    const value = index === 0 ? 'mph' : 'kph';
    setSpeedUnit(value);
    await AsyncStorage.setItem(STORAGE_KEYS.speedUnit, value);
  };

  const toggles = [
    { label: 'Show current speed',            desc: 'Large speedometer during drives.', state: showCurrentSpeed,                  setter: setShowCurrentSpeed,                  key: STORAGE_KEYS.showCurrentSpeed },
    { label: 'Show speed limit',              desc: 'Posted limit for the current road.', state: showSpeedLimit,                   setter: setShowSpeedLimit,                    key: STORAGE_KEYS.showSpeedLimit },
    { label: 'Audio speed limit updates',     desc: 'Spoken limit changes.', state: audioSpeedUpdatesEnabled,                      setter: setAudioSpeedUpdatesEnabled,          key: STORAGE_KEYS.audioSpeedUpdatesEnabled },
    { label: 'Speeding warnings',             desc: 'Alert when you exceed the limit.', state: warningsEnabled,                    setter: setWarningsEnabled,                   key: STORAGE_KEYS.warningsEnabled },
    { label: 'Distracted notifications',      desc: 'Warn when app is not focused.', state: distractedNotificationsEnabled,        setter: setDistractedNotificationsEnabled,    key: STORAGE_KEYS.distractedNotificationsEnabled },
    { label: 'Show total points',             desc: 'Replace drive points with lifetime total.', state: displayTotalPoints,    setter: setDisplayTotalPoints,                key: STORAGE_KEYS.displayTotalPoints },
  ];

  return (
    <Screen hasHeader>
      <ScrollView showsVerticalScrollIndicator={false}>
        <ScreenHeader
          align="right"
          eyebrow="Settings · Driving"
          title="Driving"
          subtitle="Customize your driving experience."
        />

        <Section label="Units">
          <Card>
            <Text style={[t.typography.subheading, { color: t.colors.text, marginBottom: 4 }]}>
              Speed units
            </Text>
            <Text style={[t.typography.caption, { color: t.colors.textMuted, marginBottom: 16 }]}>
              Used everywhere speed appears.
            </Text>
            <SegmentedControl
              values={['MPH', 'KPH']}
              selectedIndex={speedUnit === 'mph' ? 0 : 1}
              onChange={(e) => onSpeedUnitChange(e.nativeEvent.selectedSegmentIndex)}
              appearance={t.isDark ? 'dark' : 'light'}
              tintColor={t.colors.accent}
              style={{ height: 40 }}
            />
          </Card>
        </Section>

        <Section label="In-drive display">
          <Card padded={false}>
            {toggles.map((row, i) => (
              <View
                key={row.key}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: 14,
                  paddingHorizontal: 18,
                  borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                  borderTopColor: t.colors.divider,
                }}
              >
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={[t.typography.bodyStrong, { color: t.colors.text }]}>
                    {row.label}
                  </Text>
                  <Text style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 2 }]}>
                    {row.desc}
                  </Text>
                </View>
                <Switch
                  value={row.state}
                  onValueChange={async (v) => {
                    row.setter(v);
                    await AsyncStorage.setItem(row.key, v.toString());
                  }}
                  trackColor={{ false: t.isDark ? '#3a3f46' : '#c9cfd6', true: t.colors.accent }}
                  thumbColor="#fff"
                  ios_backgroundColor={t.isDark ? '#3a3f46' : '#c9cfd6'}
                />
              </View>
            ))}
          </Card>
        </Section>

        <View style={{ height: 24 }} />
      </ScrollView>
    </Screen>
  );
}

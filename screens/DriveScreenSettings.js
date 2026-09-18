// DriveScreenSettings — units, speed display and points behaviour for the drive
// screen. Every value is read from and written to SettingsContext.
import React from 'react';
import { ScrollView, View } from 'react-native';
import {
  Screen,
  Section,
  Card,
  ScreenHeader,
  Banner,
  SegmentedTabs,
  ToggleRow,
  useTheme,
} from '../theme';
import { useSettings } from '../context/SettingsContext';

const UNITS = ['mph', 'kph'];

export default function DriveScreenSettings() {
  const t = useTheme();
  const { settings, update } = useSettings();

  const unitIndex = settings.speedUnit === 'kph' ? 1 : 0;

  return (
    <Screen hasHeader>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: t.spacing[8] }}
      >
        <ScreenHeader
          eyebrow="Settings"
          title="Driving"
          subtitle="How the drive screen reads and sounds."
        />

        <Section label="Units">
          <Card>
            <SegmentedTabs
              values={['MPH', 'KM/H']}
              selectedIndex={unitIndex}
              onChange={(i) => update('speedUnit', UNITS[i])}
            />
          </Card>
        </Section>

        <Section label="Speed">
          <Card padded={false}>
            <ToggleRow
              first
              icon="speedometer-outline"
              title="Show speed limit"
              subtitle="Posted limit for the road you are on."
              value={settings.showSpeedLimit}
              onValueChange={(v) => update('showSpeedLimit', v)}
            />
            <ToggleRow
              icon="volume-medium-outline"
              title="Speak limit changes"
              subtitle="Says the new limit out loud when it changes."
              value={settings.audioSpeedUpdatesEnabled}
              onValueChange={(v) => update('audioSpeedUpdatesEnabled', v)}
            />
            <ToggleRow
              icon="warning-outline"
              title="Speeding alerts"
              subtitle="Tone and banner after 2.5 s above 125 % of the limit"
              value={settings.speedingWarningsEnabled}
              onValueChange={(v) => update('speedingWarningsEnabled', v)}
            />
          </Card>
        </Section>

        <Section label="Points">
          <Card padded={false}>
            <ToggleRow
              first
              icon="trophy-outline"
              title="Show lifetime total"
              subtitle="The drive screen shows your all-time points instead of the points earned on this drive."
              value={settings.displayTotalPoints}
              onValueChange={(v) => update('displayTotalPoints', v)}
            />
          </Card>
          <View style={{ height: 12 }} />
          <Banner
            tone="info"
            icon="information-circle-outline"
            title="How points are earned"
            body="You earn +1 point every 2.5 seconds while you are moving and staying under 125 % of the speed limit. No points are earned while you are distracted."
          />
        </Section>
      </ScrollView>
    </Screen>
  );
}

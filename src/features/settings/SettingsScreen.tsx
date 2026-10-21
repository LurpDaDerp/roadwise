import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { dashcamStatus } from '@/dashcam/ui/status';
import { useDashcamState } from '@/dashcam/ui/useDashcam';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { useMySummary, type HeatmapVisibility } from '@/data/server/summary';
import { NavAppSettingRow } from '@/features/navigation/NavAppSettingRow';
import { ReminderRow, useTripReminder, type ReminderDeps } from '@/features/reminder';
import { Banner, Card, ListRow, Screen, SegmentedControl, Sheet, Text, useTheme } from '@/ui';
import { appearance as appAppearance, APPEARANCE_CHOICES, useAppearance, type AppearanceStore } from '@/ui/appearance';

import { settingsCopy, shownVisibility, VISIBILITY_SEGMENTS } from './copy';

import { readUnits, writeUnits, type Units } from './localPrefs';
import { LinkRow, RowIcon, Section, TopBar } from './parts';
import { readZones } from './privacyZones';
import { SETTINGS_HREFS } from './routes';
import { useProfileEdit } from './useProfileEdit';
import { stateName, US_STATES } from './usStates';

const copy = settingsCopy.root;

const UNIT_SEGMENTS = [
  { value: 'mi' as const, label: 'Miles' },
  { value: 'km' as const, label: 'Kilometers' },
];

/** A labelled segmented control inside a settings card. */
function SegmentRow<V extends string>({
  title,
  value,
  segments,
  onChange,
  testID,
}: {
  title: string;
  value: V | null;
  segments: readonly { value: V; label: string }[];
  onChange: (v: V) => void;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <View style={{ gap: th.space.sm, paddingVertical: th.space.md, paddingHorizontal: th.space.lg }}>
      <Text variant="body">{title}</Text>
      <SegmentedControl
        segments={segments}
        value={(value ?? segments[0]!.value) as V}
        onChange={onChange}
        accessibilityLabel={title}
        testID={testID}
      />
    </View>
  );
}

/** One choice in a sheet of radio rows: its label, an optional line under it, and a tick when chosen. */
function RadioRow({ label, detail, chosen, onPress }: { label: string; detail?: string; chosen: boolean; onPress: () => void }) {
  const th = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: chosen }}
      accessibilityLabel={label}
      accessibilityHint={detail}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: th.size.touch,
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space.md,
        paddingHorizontal: th.space.lg,
        paddingVertical: th.space.sm,
        backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
      })}
    >
      <View style={{ flex: 1 }}>
        <Text variant="body">{label}</Text>
        {detail ? (
          <Text variant="footnote" tone="muted">
            {detail}
          </Text>
        ) : null}
      </View>
      {chosen ? <Ionicons name="checkmark" size={th.size.icon} color={th.colors.accent} /> : null}
    </Pressable>
  );
}

/**
 * `/settings`: everything a driver tunes, grouped by what it touches — the drive, privacy, the
 * public profile, notifications. Every control saves as it changes; there is no Save button.
 * Appearance is this phone's own (`src/ui/appearance.ts`): it lands at once and is never uploaded.
 */
export function SettingsScreen({ deps = {} }: { deps?: { reminder?: ReminderDeps; appearance?: AppearanceStore } }) {
  const router = useRouter();
  const th = useTheme();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const summary = useMySummary();
  const profile = summary.data?.profile;
  const edit = useProfileEdit();
  const reminder = useTripReminder(deps.reminder);

  const [units, setUnits] = useState<Units | null>(null);
  const [zoneCount, setZoneCount] = useState(0);
  const [stateSheet, setStateSheet] = useState(false);
  const [lookSheet, setLookSheet] = useState(false);
  const looks = deps.appearance ?? appAppearance;
  const look = useAppearance(looks).choice;

  // Read on every focus, so a zone added a screen deeper shows in the count on the way back.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      void Promise.all([readUnits(settings), readZones(settings)])
        .then(([u, z]) => {
          if (!live) return;
          setUnits(u);
          setZoneCount(z.length);
        })
        .catch(() => {});
      return () => {
        live = false;
      };
    }, [settings])
  );

  // The local mirror follows the server: written only once `update_profile` has taken the change.
  const onUnits = async (next: Units) => {
    if (!(await edit.save('units', next))) return;
    setUnits(next);
    await writeUnits(settings, next).catch(() => {});
  };

  // Another device changed units: bring this phone's mirror (offline display) in line.
  const serverUnits = profile?.units;
  useEffect(() => {
    if (!serverUnits || units === null || serverUnits === units) return;
    void writeUnits(settings, serverUnits)
      .then(() => setUnits(serverUnits))
      .catch(() => {});
  }, [serverUnits, units, settings]);

  const dashcam = dashcamStatus(useDashcamState());

  const shownUnits = edit.value('units', profile?.units) ?? units;
  const shownState = edit.value('state', profile?.state ?? '');

  return (
    <Screen scroll testID="settings-screen">
      <TopBar title={settingsCopy.title} />
      {edit.error ? <Banner tone="danger" message={copy.saveError} testID="settings-save-error" /> : null}

      <Section title={copy.driving}>
        <LinkRow icon="videocam-outline" title={copy.dashcam.title} subtitle={dashcam.label} onPress={() => router.push(SETTINGS_HREFS.dashcam)} testID="settings-dashcam" />
        <LinkRow icon="volume-high-outline" title={copy.alerts.title} subtitle={copy.alerts.subtitle} onPress={() => router.push(SETTINGS_HREFS.alerts)} testID="settings-alerts" />
        <NavAppSettingRow db={db} />
        {reminder.status ? <ReminderRow status={reminder.status} onStatus={reminder.setStatus} deps={deps.reminder} /> : null}
        <LinkRow icon="shield-checkmark-outline" title={copy.permissions.title} subtitle={copy.permissions.subtitle} onPress={() => router.push(SETTINGS_HREFS.permissions)} testID="settings-permissions" />
      </Section>

      <Section title={copy.privacy} footer={copy.heatmapFooter}>
        <LinkRow icon="location-outline" title={copy.zones.title} subtitle={copy.zones.subtitle(zoneCount)} onPress={() => router.push(SETTINGS_HREFS.privacyZones)} testID="settings-zones" />
        <SegmentRow<HeatmapVisibility>
          title={copy.heatmap}
          value={shownVisibility(edit.value('heatmap_visibility', profile?.heatmap_visibility))}
          segments={VISIBILITY_SEGMENTS}
          onChange={(v) => void edit.save('heatmap_visibility', v)}
          testID="settings-heatmap-visibility"
        />
      </Section>

      <Section title={copy.you}>
        <SegmentRow<Units> title={copy.units} value={shownUnits} segments={UNIT_SEGMENTS} onChange={(v) => void onUnits(v)} testID="settings-units" />
        <ListRow
          title={copy.state.title}
          subtitle={stateName(shownState) ?? copy.state.subtitle}
          leading={<RowIcon name="map-outline" />}
          onPress={() => setStateSheet(true)}
          testID="settings-state"
        />
        <ListRow
          title={copy.appearance.title}
          subtitle={copy.appearance.options[look].label}
          leading={<RowIcon name="contrast-outline" />}
          onPress={() => setLookSheet(true)}
          testID="settings-appearance"
        />
      </Section>

      <Section>
        <LinkRow icon="notifications-outline" title={copy.notifications.title} subtitle={copy.notifications.subtitle} onPress={() => router.push(SETTINGS_HREFS.notifications)} testID="settings-notifications" />
      </Section>

      <Sheet visible={stateSheet} onClose={() => setStateSheet(false)} title={settingsCopy.states.title} scroll testID="settings-state-sheet">
        <Card padded={false}>
          {[['', settingsCopy.states.none] as const, ...US_STATES].map(([code, name]) => (
            <RadioRow
              key={code || 'none'}
              label={name}
              chosen={(shownState ?? '') === code}
              onPress={() => {
                setStateSheet(false);
                void edit.save('state', code);
              }}
            />
          ))}
        </Card>
      </Sheet>

      <Sheet visible={lookSheet} onClose={() => setLookSheet(false)} title={copy.appearance.sheetTitle} testID="settings-appearance-sheet">
        <View style={{ gap: th.space.sm }}>
          <Card padded={false}>
            {APPEARANCE_CHOICES.map((choice) => (
              <RadioRow
                key={choice}
                label={copy.appearance.options[choice].label}
                detail={copy.appearance.options[choice].detail}
                chosen={look === choice}
                onPress={() => {
                  setLookSheet(false);
                  looks.set(choice);
                }}
              />
            ))}
          </Card>
          <Text variant="footnote" tone="muted">
            {copy.appearance.footer}
          </Text>
        </View>
      </Sheet>
    </Screen>
  );
}

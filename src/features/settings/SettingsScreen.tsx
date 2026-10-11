import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';

import type { PermissionsAdapter } from '@/core/permissions';
import { dashcamStatus } from '@/dashcam/ui/status';
import { useDashcamState } from '@/dashcam/ui/useDashcam';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { useMySummary, type HeatmapVisibility, type LicenseStage } from '@/data/server/summary';
import { Banner, Card, ListRow, Screen, SegmentedControl, Sheet, Text, ToggleRow, useTheme } from '@/ui';

import { LICENSE_SHORT, settingsCopy, VISIBILITY_SEGMENTS } from './copy';
import { defaultPermissionsAdapter } from '@/features/permissions/usePermissionHealth';

import { ensureReminderPermissions, readReminder, readUnits, writeReminder, writeUnits, type ReminderNeed, type Units } from './localPrefs';
import { LinkRow, RowIcon, Section, TopBar } from './parts';
import { readZones } from './privacyZones';
import { SETTINGS_HREFS } from './routes';
import { useProfileEdit } from './useProfileEdit';
import { stateName, US_STATES } from './usStates';

const copy = settingsCopy.root;

const LICENSE_SEGMENTS = (['permit', 'intermediate', 'full'] as const).map((v) => ({ value: v, label: LICENSE_SHORT[v] }));
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

/**
 * `/settings`: everything a driver tunes, grouped by what it touches — the drive, privacy, the
 * public profile, notifications. Every control saves as it changes; there is no Save button.
 */
export function SettingsScreen({ deps = {} }: { deps?: { adapter?: PermissionsAdapter } }) {
  const router = useRouter();
  const th = useTheme();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const summary = useMySummary();
  const profile = summary.data?.profile;
  const edit = useProfileEdit();

  const [reminder, setReminder] = useState(false);
  const [units, setUnits] = useState<Units | null>(null);
  const [zoneCount, setZoneCount] = useState(0);
  const [stateSheet, setStateSheet] = useState(false);
  const [localError, setLocalError] = useState(false);
  const [needs, setNeeds] = useState<ReminderNeed[]>([]);

  // Read on every focus, so a zone added a screen deeper shows in the count on the way back.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      void Promise.all([readReminder(settings), readUnits(settings), readZones(settings)])
        .then(([r, u, z]) => {
          if (!live) return;
          setReminder(r);
          setUnits(u);
          setZoneCount(z.length);
        })
        .catch(() => {});
      return () => {
        live = false;
      };
    }, [settings])
  );

  // On: ask for what the reminder needs first (motion; notifications on Android). Without them it
  // would silently do nothing, so it stays off and says what is missing.
  const onReminder = async (next: boolean) => {
    setLocalError(false);
    setNeeds([]);
    if (next) {
      const missing = await ensureReminderPermissions(deps.adapter ?? defaultPermissionsAdapter());
      if (missing.length > 0) {
        setNeeds(missing);
        return;
      }
    }
    setReminder(next);
    writeReminder(settings, next).catch(() => {
      setReminder(!next);
      setLocalError(true);
    });
  };
  const needsLine =
    needs.length === 2 ? copy.reminder.needs.both : needs[0] ? copy.reminder.needs[needs[0]] : null;

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

  const dashcam = dashcamStatus(useDashcamState(), Platform.OS === 'ios' ? 'ios' : 'android');

  const shownUnits = edit.value('units', profile?.units) ?? units;
  const shownState = edit.value('state', profile?.state ?? '');

  return (
    <Screen scroll testID="settings-screen">
      <TopBar title={settingsCopy.title} />
      {edit.error || localError ? <Banner tone="danger" message={copy.saveError} testID="settings-save-error" /> : null}

      {needsLine ? (
        <Banner
          tone="warning"
          message={needsLine}
          action={{
            label: copy.reminder.openSettings,
            onPress: () => void (deps.adapter ?? defaultPermissionsAdapter()).openAppSettings().catch(() => {}),
          }}
          testID="settings-reminder-needs"
        />
      ) : null}
      <Section title={copy.driving}>
        <LinkRow icon="videocam-outline" title={copy.dashcam.title} subtitle={dashcam.label} onPress={() => router.push(SETTINGS_HREFS.dashcam)} testID="settings-dashcam" />
        <LinkRow icon="volume-high-outline" title={copy.alerts.title} subtitle={copy.alerts.subtitle} onPress={() => router.push(SETTINGS_HREFS.alerts)} testID="settings-alerts" />
        <ToggleRow title={copy.reminder.title} subtitle={copy.reminder.subtitle} value={reminder} onValueChange={(v) => void onReminder(v)} testID="settings-reminder" />
        <LinkRow icon="shield-checkmark-outline" title={copy.permissions.title} subtitle={copy.permissions.subtitle} onPress={() => router.push(SETTINGS_HREFS.permissions)} testID="settings-permissions" />
      </Section>

      <Section title={copy.privacy} footer={copy.heatmapFooter}>
        <LinkRow icon="location-outline" title={copy.zones.title} subtitle={copy.zones.subtitle(zoneCount)} onPress={() => router.push(SETTINGS_HREFS.privacyZones)} testID="settings-zones" />
        <SegmentRow<HeatmapVisibility>
          title={copy.heatmap}
          value={edit.value('heatmap_visibility', profile?.heatmap_visibility)}
          segments={VISIBILITY_SEGMENTS}
          onChange={(v) => void edit.save('heatmap_visibility', v)}
          testID="settings-heatmap-visibility"
        />
      </Section>

      <Section title={copy.you}>
        <SegmentRow<LicenseStage>
          title={copy.license}
          value={edit.value('license_stage', profile?.license_stage)}
          segments={LICENSE_SEGMENTS}
          onChange={(v) => void edit.save('license_stage', v)}
          testID="settings-license"
        />
        <SegmentRow<Units> title={copy.units} value={shownUnits} segments={UNIT_SEGMENTS} onChange={(v) => void onUnits(v)} testID="settings-units" />
        <ListRow
          title={copy.state.title}
          subtitle={stateName(shownState) ?? copy.state.subtitle}
          leading={<RowIcon name="map-outline" />}
          onPress={() => setStateSheet(true)}
          testID="settings-state"
        />
      </Section>

      <Section>
        <LinkRow icon="notifications-outline" title={copy.notifications.title} subtitle={copy.notifications.subtitle} onPress={() => router.push(SETTINGS_HREFS.notifications)} testID="settings-notifications" />
      </Section>

      <Sheet visible={stateSheet} onClose={() => setStateSheet(false)} title={settingsCopy.states.title} scroll testID="settings-state-sheet">
        <Card padded={false}>
          {[['', settingsCopy.states.none] as const, ...US_STATES].map(([code, name]) => {
            const chosen = (shownState ?? '') === code;
            return (
              <Pressable
                key={code || 'none'}
                accessibilityRole="radio"
                accessibilityState={{ checked: chosen }}
                accessibilityLabel={name}
                onPress={() => {
                  setStateSheet(false);
                  void edit.save('state', code);
                }}
                style={({ pressed }) => ({
                  minHeight: th.size.touch,
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: th.space.lg,
                  paddingVertical: th.space.sm,
                  backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
                })}
              >
                <Text variant="body" style={{ flex: 1 }}>
                  {name}
                </Text>
                {chosen ? <Ionicons name="checkmark" size={th.size.icon} color={th.colors.accent} /> : null}
              </Pressable>
            );
          })}
        </Card>
      </Sheet>
    </Screen>
  );
}

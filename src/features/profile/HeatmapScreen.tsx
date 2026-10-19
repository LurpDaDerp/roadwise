import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { useMySummary, type HeatmapVisibility } from '@/data/server/summary';
import { shownVisibility, VISIBILITY_SEGMENTS } from '@/features/settings/copy';
import { LinkRow, Section, TopBar } from '@/features/settings/parts';
import { SETTINGS_HREFS } from '@/features/settings/routes';
import { useProfileEdit } from '@/features/settings/useProfileEdit';
import { Banner, Card, SegmentedControl, Screen, Text, useTheme } from '@/ui';

import { profileCopy } from './copy';

const copy = profileCopy.heatmap;

/**
 * `/heatmap`: who can see this driver's heat map (Only me · Friends; a saved `'clan'` shows as
 * Only me, as the server treats it), the way to their privacy zones and what is always left out. The map itself lives in
 * Analytics.
 */
export function HeatmapScreen() {
  const th = useTheme();
  const router = useRouter();
  const profile = useMySummary().data?.profile;
  const edit = useProfileEdit();

  return (
    <Screen scroll testID="heatmap-screen">
      <TopBar title={copy.title} />
      <Text variant="subhead" tone="muted" testID="heatmap-intro">
        {copy.intro}
      </Text>

      {edit.error ? <Banner tone="danger" message={edit.error} testID="heatmap-save-error" /> : null}
      <Card testID="heatmap-visibility-card">
        <Text variant="headline" accessibilityRole="header">
          {copy.visibility}
        </Text>
        <SegmentedControl<HeatmapVisibility>
          segments={VISIBILITY_SEGMENTS}
          value={shownVisibility(edit.value('heatmap_visibility', profile?.heatmap_visibility)) ?? 'only_me'}
          onChange={(v) => void edit.save('heatmap_visibility', v)}
          accessibilityLabel={copy.visibility}
          testID="heatmap-visibility"
        />
        <Text variant="footnote" tone="muted" testID="heatmap-visibility-hint">
          {copy.visibilityHint}
        </Text>
      </Card>

      <Section>
        <LinkRow
          icon="eye-off-outline"
          title={copy.zones}
          subtitle={copy.zonesSubtitle}
          onPress={() => router.push(SETTINGS_HREFS.privacyZones)}
          testID="heatmap-zones"
        />
      </Section>

      <View style={{ flexDirection: 'row', gap: th.space.sm, alignItems: 'flex-start' }}>
        <Ionicons name="lock-closed-outline" size={th.size.icon} color={th.colors.textMuted} accessibilityElementsHidden importantForAccessibility="no" />
        <Text variant="footnote" tone="muted" style={{ flex: 1 }} testID="heatmap-privacy">
          {copy.privacy}
        </Text>
      </View>
    </Screen>
  );
}

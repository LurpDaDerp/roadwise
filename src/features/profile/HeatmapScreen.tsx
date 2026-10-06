import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { useMySummary, type HeatmapVisibility } from '@/data/server/summary';
import { SETTINGS_HREFS } from '@/features/settings/routes';
import { LinkRow, Section, TopBar } from '@/features/settings/parts';
import { VISIBILITY_SEGMENTS } from '@/features/settings/copy';
import { useProfileEdit } from '@/features/settings/useProfileEdit';
import { Banner, Card, EmptyState, SegmentedControl, Screen, Skeleton, Text, useTheme } from '@/ui';

import { profileCopy } from './copy';
import { useOwnRoutes } from './ownRoutes';
import { RouteHeatMap } from './RouteHeatMap';

const copy = profileCopy.heatmap;

/**
 * `/heatmap`: the roads this driver takes most, from their own drives on this phone (already
 * trimmed for privacy zones and the first and last quarter mile), with who may see it.
 */
export function HeatmapScreen() {
  const th = useTheme();
  const router = useRouter();
  const routes = useOwnRoutes();
  const profile = useMySummary().data?.profile;
  const edit = useProfileEdit();
  const list = routes.data ?? [];

  return (
    <Screen scroll testID="heatmap-screen">
      <TopBar title={copy.title} />
      {routes.loading ? (
        <Skeleton width="100%" height={360} />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState icon="map-outline" title={copy.empty} body={copy.emptyBody} testID="heatmap-empty" />
        </Card>
      ) : (
        <View style={{ gap: th.space.sm }}>
          <RouteHeatMap polylines={list} testID="heatmap-map" />
          <Text variant="footnote" tone="muted" testID="heatmap-count">
            {copy.drives(list.length)}
          </Text>
        </View>
      )}

      <View style={{ flexDirection: 'row', gap: th.space.sm, alignItems: 'flex-start' }}>
        <Ionicons name="lock-closed-outline" size={th.size.icon} color={th.colors.textMuted} />
        <Text variant="footnote" tone="muted" style={{ flex: 1 }} testID="heatmap-privacy">
          {copy.privacy}
        </Text>
      </View>

      {edit.error ? <Banner tone="danger" message={edit.error} /> : null}
      <View style={{ gap: th.space.sm }}>
        <Text variant="headline" accessibilityRole="header">
          {copy.visibility}
        </Text>
        <SegmentedControl<HeatmapVisibility>
          segments={VISIBILITY_SEGMENTS}
          value={edit.value('heatmap_visibility', profile?.heatmap_visibility) ?? 'only_me'}
          onChange={(v) => void edit.save('heatmap_visibility', v)}
          accessibilityLabel={copy.visibility}
          testID="heatmap-visibility"
        />
        <Text variant="footnote" tone="muted">
          {copy.visibilityHint}
        </Text>
      </View>

      <Section>
        <LinkRow icon="eye-off-outline" title={copy.zones} onPress={() => router.push(SETTINGS_HREFS.privacyZones)} testID="heatmap-zones" />
      </Section>
    </Screen>
  );
}

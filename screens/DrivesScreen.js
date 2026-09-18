// DrivesScreen — the Drives tab: History and Insights over one cached copy of
// the drive history (replaces MyDrivesScreen + AIScreen).
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, RefreshControl, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { Screen, ScreenHeader, SegmentedTabs, useTheme } from '../theme';
import { HistoryPanel, InsightsPanel } from '../components/drives';
import { useAuthContext } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import { getDriveHistoryPage, getDriveCounts } from '../utils/firestore';
import { serializeDrive } from '../utils/format';

const TABS = ['History', 'Insights'];

export default function DrivesScreen({ navigation, route }) {
  const t = useTheme();
  const { uid } = useAuthContext();
  const { settings } = useSettings();
  const unit = settings?.speedUnit || 'mph';

  const [tab, setTab] = useState(route?.params?.tab === 'insights' ? 1 : 0);
  const [drives, setDrives] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const PAGE_SIZE = 20;

  // Home deep-links into a specific tab; consume the param so a repeat
  // navigation with the same value still switches tabs.
  useEffect(() => {
    const requested = route?.params?.tab;
    if (!requested) return;
    setTab(requested === 'insights' ? 1 : 0);
    navigation.setParams({ tab: undefined });
  }, [route?.params?.tab, navigation]);

  // First page + the summary counts (server count queries; the whole history is
  // never held in memory). "Load more" fetches the next page with the cursor.
  const load = useCallback(async () => {
    if (!uid) return { page: { drives: [], cursor: null, hasMore: false }, counts: { total: 0, distracted: 0, focused: 0 } };
    const [page, driveCounts] = await Promise.all([
      getDriveHistoryPage(uid, { pageSize: PAGE_SIZE }),
      getDriveCounts(uid),
    ]);
    return { page, counts: driveCounts };
  }, [uid]);

  const apply = useCallback(({ page, counts: driveCounts }) => {
    setDrives(page.drives);
    setCursor(page.cursor);
    setHasMore(page.hasMore);
    setCounts(driveCounts);
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        const result = await load();
        if (alive) apply(result);
      })();
      return () => {
        alive = false;
      };
    }, [load, apply])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    apply(await load());
    setRefreshing(false);
  }, [load, apply]);

  const loadMore = useCallback(async () => {
    if (!uid || !cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getDriveHistoryPage(uid, { pageSize: PAGE_SIZE, cursor });
      setDrives((prev) => [...prev, ...page.drives]);
      setCursor(page.cursor);
      setHasMore(page.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }, [uid, cursor, loadingMore]);

  const openDrive = useCallback(
    (drive) => navigation.navigate('DriveDetail', { drive: serializeDrive(drive) }),
    [navigation]
  );

  return (
    <Screen>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={t.colors.accent}
            colors={[t.colors.accent]}
          />
        }
      >
        <ScreenHeader eyebrow="Drives" title="Your drives" />

        <View style={{ marginBottom: 24 }}>
          <SegmentedTabs values={TABS} selectedIndex={tab} onChange={setTab} />
        </View>

        {tab === 0 ? (
          <HistoryPanel
            drives={drives}
            counts={counts}
            loading={loading}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
            unit={unit}
            onSelectDrive={openDrive}
          />
        ) : (
          <InsightsPanel uid={uid} unit={unit} navigation={navigation} />
        )}
      </ScrollView>
    </Screen>
  );
}

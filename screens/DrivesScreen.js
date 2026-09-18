// DrivesScreen — the Drives tab: History and Insights over one cached copy of
// the drive history (replaces MyDrivesScreen + AIScreen).
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, RefreshControl, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { Screen, ScreenHeader, SegmentedTabs, useTheme } from '../theme';
import { HistoryPanel, InsightsPanel } from '../components/drives';
import { useAuthContext } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import { getUserDrives } from '../utils/firestore';
import { serializeDrive } from '../utils/format';

const TABS = ['History', 'Insights'];

export default function DrivesScreen({ navigation, route }) {
  const t = useTheme();
  const { uid } = useAuthContext();
  const { settings } = useSettings();
  const unit = settings?.speedUnit || 'mph';

  const [tab, setTab] = useState(route?.params?.tab === 'insights' ? 1 : 0);
  const [drives, setDrives] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Home deep-links into a specific tab; consume the param so a repeat
  // navigation with the same value still switches tabs.
  useEffect(() => {
    const requested = route?.params?.tab;
    if (!requested) return;
    setTab(requested === 'insights' ? 1 : 0);
    navigation.setParams({ tab: undefined });
  }, [route?.params?.tab, navigation]);

  const load = useCallback(async () => {
    if (!uid) return [];
    return getUserDrives(uid);
  }, [uid]);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        const fetched = await load();
        if (!alive) return;
        setDrives(fetched);
        setLoading(false);
      })();
      return () => {
        alive = false;
      };
    }, [load])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const fetched = await load();
    setDrives(fetched);
    setLoading(false);
    setRefreshing(false);
  }, [load]);

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
            loading={loading}
            unit={unit}
            onSelectDrive={openDrive}
          />
        ) : (
          <InsightsPanel drives={drives} unit={unit} navigation={navigation} />
        )}
      </ScrollView>
    </Screen>
  );
}

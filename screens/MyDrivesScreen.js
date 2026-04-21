import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Alert,
  Modal,
  Pressable,
  ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { getUserDrives, clearUserDrives } from '../utils/firestore';
import { auth } from '../utils/firebase';
import {
  Screen,
  Section,
  Card,
  ScreenHeader,
  Button,
  AutoFitText,
  useTheme,
} from '../theme';

const LOAD_BATCH = 10;

function interpolateColor(percent) {
  const p = Math.min(Math.max(percent, 0), 75) / 75;
  const start = { r: 12, g: 200, b: 120 };
  const end = { r: 230, g: 80, b: 80 };
  const r = Math.round(start.r + (end.r - start.r) * p);
  const g = Math.round(start.g + (end.g - start.g) * p);
  const b = Math.round(start.b + (end.b - start.b) * p);
  return `rgb(${r},${g},${b})`;
}

const formatDuration = (seconds) => {
  const minutes = Math.round(seconds / 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const min = minutes - hours * 60;
    return `${hours} hr ${min} min`;
  }
  return `${minutes} min`;
};

const formatDistance = (meters) => {
  const miles = meters / 1609.34;
  if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`;
  return `${miles.toFixed(1)} mi`;
};

export default function MyDrivesScreen() {
  const t = useTheme();
  const [drives, setDrives] = useState([]);
  const [visibleCount, setVisibleCount] = useState(LOAD_BATCH);
  const [selectedDrive, setSelectedDrive] = useState(null);
  const [showModal, setShowModal] = useState(false);

  const loadDrives = async () => {
    const user = auth.currentUser;
    if (!user) return setDrives([]);
    const fetched = await getUserDrives(user.uid);
    setDrives(fetched);
    setVisibleCount(LOAD_BATCH);
  };

  useFocusEffect(
    useCallback(() => {
      loadDrives();
    }, [])
  );

  const distractedCount = drives.filter((d) => d.distracted).length;
  const focusedCount = drives.length - distractedCount;
  const percentDistracted =
    drives.length > 0
      ? Math.round((distractedCount / drives.length) * 10000) / 100
      : null;
  const percentColor =
    percentDistracted !== null ? interpolateColor(percentDistracted) : t.colors.textMuted;

  const clearDriveHistory = () => {
    Alert.alert(
      'Clear drive history',
      'Are you sure you want to clear all drive history? This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            try {
              const user = auth.currentUser;
              if (!user) return;
              await clearUserDrives(user.uid);
              setDrives([]);
            } catch (e) {
              console.warn('Failed to clear drive history:', e);
            }
          },
        },
      ],
      { cancelable: true }
    );
  };

  const renderItem = ({ item, index }) => {
    const isFirst = index === 0;
    const date = new Date(item.timestamp);
    return (
      <Pressable
        onPress={() => {
          setSelectedDrive(item);
          setShowModal(true);
        }}
        style={({ pressed }) => ({
          opacity: pressed ? 0.7 : 1,
          paddingVertical: 14,
          paddingHorizontal: 18,
          borderTopWidth: isFirst ? 0 : StyleSheet.hairlineWidth,
          borderTopColor: t.colors.divider,
          flexDirection: 'row',
          alignItems: 'center',
        })}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: item.distracted ? t.colors.dangerFaint : t.colors.accentFaint,
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 14,
          }}
        >
          <Ionicons
            name={item.distracted ? 'alert-circle-outline' : 'checkmark-circle-outline'}
            size={20}
            color={item.distracted ? t.colors.danger : t.colors.accent}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[t.typography.bodyStrong, { color: t.colors.text }]}>
            {date.toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}{' '}
            ·{' '}
            {date.toLocaleTimeString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            })}
          </Text>
          <Text style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 2 }]}>
            {formatDuration(item.duration)} · {item.points} pts
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={t.colors.textSubtle} />
      </Pressable>
    );
  };

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}>
        <ScreenHeader
          align="right"
          eyebrow="Drives"
          title="My drives"
          subtitle="Every trip, logged and scored."
        />

        <Section label="Summary">
          <Card>
            <View style={{ flexDirection: 'row' }}>
              <StatCell t={t} label="Drives" value={String(drives.length)} />
              <Divider t={t} />
              <StatCell
                t={t}
                label="Focused"
                value={String(focusedCount)}
                color={t.colors.accent}
              />
              <Divider t={t} />
              <StatCell
                t={t}
                label="Distracted"
                value={
                  percentDistracted !== null ? `${percentDistracted.toFixed(0)}%` : '—'
                }
                color={percentColor}
              />
            </View>
          </Card>
        </Section>

        <Section label="History">
          <Card padded={false}>
            {drives.length === 0 ? (
              <View style={{ paddingVertical: 36, paddingHorizontal: 20, alignItems: 'center' }}>
                <View
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 24,
                    backgroundColor: t.colors.accentFaint,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 12,
                  }}
                >
                  <Ionicons name="car-outline" size={22} color={t.colors.accent} />
                </View>
                <Text
                  style={[t.typography.subheading, { color: t.colors.text, marginBottom: 4 }]}
                >
                  No drives yet
                </Text>
                <Text
                  style={[
                    t.typography.caption,
                    { color: t.colors.textMuted, textAlign: 'center', maxWidth: 260 },
                  ]}
                >
                  Start a drive from the dashboard to begin earning points.
                </Text>
              </View>
            ) : (
              <FlatList
                data={drives.slice(0, visibleCount)}
                keyExtractor={(_, i) => i.toString()}
                scrollEnabled={false}
                renderItem={renderItem}
              />
            )}
          </Card>

          {visibleCount < drives.length && (
            <View style={{ marginTop: 12 }}>
              <Button
                title="Load more"
                variant="ghost"
                onPress={() => setVisibleCount((p) => p + LOAD_BATCH)}
              />
            </View>
          )}
        </Section>

        {drives.length > 0 && (
          <Section>
            <Button
              title="Clear drive history"
              variant="danger"
              icon={<Ionicons name="trash-outline" size={18} color="#fff" />}
              onPress={clearDriveHistory}
            />
          </Section>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>

      <Modal
        visible={showModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowModal(false)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.55)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 24,
          }}
        >
          <Card style={{ width: '100%', maxWidth: 460 }}>
            {selectedDrive && (
              <>
                <Text
                  style={[
                    t.typography.micro,
                    {
                      color: t.colors.textMuted,
                      textTransform: 'uppercase',
                      letterSpacing: 1.2,
                      marginBottom: 6,
                    },
                  ]}
                >
                  Drive details
                </Text>
                <Text style={[t.typography.heading, { color: t.colors.text }]}>
                  {new Date(selectedDrive.timestamp).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: true,
                  })}
                </Text>
                <Text
                  style={[
                    t.typography.bodyStrong,
                    {
                      color: selectedDrive.distracted ? t.colors.danger : t.colors.accent,
                      marginTop: 6,
                      marginBottom: 18,
                    },
                  ]}
                >
                  {selectedDrive.distracted ? 'Distracted drive' : 'Focused drive'}
                </Text>

                <ModalStat t={t} label="Distractions" value={selectedDrive.distracted ?? 0} first />
                <ModalStat t={t} label="Sudden stops" value={selectedDrive.suddenStops ?? 0} />
                <ModalStat
                  t={t}
                  label="Sudden accelerations"
                  value={selectedDrive.suddenAccelerations ?? 0}
                />
                <ModalStat
                  t={t}
                  label="Speeding events"
                  value={selectedDrive.speedingEvents ?? 0}
                />
                <ModalStat t={t} label="Points" value={selectedDrive.points} accent />
                <ModalStat
                  t={t}
                  label="Distance"
                  value={formatDistance(selectedDrive.totalDistance)}
                />
                <ModalStat t={t} label="Duration" value={formatDuration(selectedDrive.duration)} />
                <ModalStat
                  t={t}
                  label="Avg speed"
                  value={
                    selectedDrive.avgSpeed?.toFixed
                      ? `${selectedDrive.avgSpeed.toFixed(1)}`
                      : 'N/A'
                  }
                />
              </>
            )}

            <View style={{ marginTop: 20 }}>
              <Button title="Close" variant="ghost" onPress={() => setShowModal(false)} />
            </View>
          </Card>
        </View>
      </Modal>
    </Screen>
  );
}

function StatCell({ t, label, value, color }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', paddingVertical: 6 }}>
      <Text
        style={[
          t.typography.micro,
          {
            color: t.colors.textMuted,
            textTransform: 'uppercase',
            letterSpacing: 1.1,
            marginBottom: 6,
          },
        ]}
      >
        {label}
      </Text>
      <AutoFitText style={[t.typography.numeric, { color: color || t.colors.text }]}>
        {value}
      </AutoFitText>
    </View>
  );
}

function Divider({ t }) {
  return (
    <View
      style={{
        width: StyleSheet.hairlineWidth,
        backgroundColor: t.colors.divider,
        marginVertical: 4,
      }}
    />
  );
}

function ModalStat({ t, label, value, first, accent }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 10,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: t.colors.divider,
      }}
    >
      <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>{label}</Text>
      <Text
        style={[
          t.typography.bodyStrong,
          { color: accent ? t.colors.accent : t.colors.text },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

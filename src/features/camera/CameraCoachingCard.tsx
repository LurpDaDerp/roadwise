// The trip summary's optional "Camera coaching" card: a few numbers from the drive's local DMS summary (coaching.ts)
// and one static tip drawn from them. Only for a drive the camera saw; nothing for any other trip. On the phone only.
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries';
import { Text, useTheme } from '@/ui';

import { readCoaching, type CameraCoaching } from './coaching';
import { cameraCopy } from './copy';

const copy = cameraCopy.coaching;

/** The card's lines, in order; the tip last. Pure, for the test. */
export function coachingLines(c: CameraCoaching): { facts: string[]; tip: string | null } {
  const facts: string[] = [];
  if (c.seenPct !== null) facts.push(copy.seen(c.seenPct));
  facts.push(copy.longGlances(c.glancesOver2s));
  if (c.longestGlanceS !== null && c.glancesOver2s > 0) facts.push(copy.longestGlance(c.longestGlanceS));
  if (c.distractionAlerts > 0) facts.push(copy.distractionAlerts(c.distractionAlerts));
  if (c.sleepAlerts > 0) facts.push(copy.sleepAlerts(c.sleepAlerts));
  let tip: string | null = null;
  if (c.sleepAlerts > 0) tip = copy.tipSleep;
  else if (c.glancesOver2s > 0) tip = copy.tipGlances;
  else if (c.cameraSession === 'limited') tip = copy.limited;
  else tip = copy.clean;
  return { facts, tip };
}

export function CameraCoachingCard({ clientTripId }: { clientTripId: string }) {
  const th = useTheme();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const [card, setCard] = useState<CameraCoaching | null>(null);
  useEffect(() => {
    let live = true;
    void readCoaching(settings, clientTripId).then((c) => {
      if (live) setCard(c);
    });
    return () => {
      live = false;
    };
  }, [settings, clientTripId]);
  if (card === null) return null;
  const { facts, tip } = coachingLines(card);
  return (
    <View
      testID="camera-coaching-card"
      style={{
        gap: th.space.sm,
        padding: th.space.lg,
        borderRadius: th.radius.md,
        borderWidth: 1,
        borderColor: th.colors.border,
        backgroundColor: th.colors.surface,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm }}>
        <Ionicons name="eye-outline" size={22} color={th.colors.accent} accessibilityElementsHidden importantForAccessibility="no" />
        <Text variant="headline" accessibilityRole="header" style={{ flex: 1 }}>
          {copy.title}
        </Text>
        <Text variant="caption" tone="muted">
          {copy.beta}
        </Text>
      </View>
      {facts.map((f) => (
        <Text key={f} variant="subhead">
          {f}
        </Text>
      ))}
      {tip ? (
        <Text variant="subhead" tone="muted" testID="camera-coaching-tip">
          {tip}
        </Text>
      ) : null}
    </View>
  );
}

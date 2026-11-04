import type { Href } from 'expo-router';
import { useRouter } from 'expo-router';
import { useSyncExternalStore } from 'react';
import { View } from 'react-native';

import { Card, IconButton, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../copy';
import type { DashcamState } from '../runtime';
import { useDashcamSelector } from './useDashcam';

const copy = dashpalCopy.screen.reaim;

/** Settings › DashPal with its camera view open (`app/(app)/settings/dashcam.tsx` reads `aim`). */
export const DASHCAM_AIM_HREF = { pathname: '/settings/dashcam', params: { aim: '1' } } as Href;

const selectReaim = (s: DashcamState | null): boolean => s?.reaim === true && s.link.paired !== null;

/** Closed with its ✕ ("Not now"): hidden until RoadWise next starts. */
let snoozed = false;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const readSnoozed = () => snoozed;
function setSnoozed(next: boolean): void {
  snoozed = next;
  for (const l of listeners) l();
}
/** Tests: forget a "Not now". */
export const resetReaimSnooze = (): void => setSnoozed(false);

/**
 * Home's reminder that the paired DashPal's camera needs adjusting (its STATUS bit 7, kept while the
 * DashPal is off): a tap opens Settings › DashPal with the camera view. Its ✕ (top right, also the
 * screen reader's "Not now") hides it until RoadWise next starts; it goes for good when the DashPal
 * says its camera is fine again. Never while a drive is open (`hidden`).
 */
export function ReaimCard({ hidden = false }: { hidden?: boolean }) {
  const th = useTheme();
  const router = useRouter();
  const show = useDashcamSelector(selectReaim);
  const isSnoozed = useSyncExternalStore(subscribe, readSnoozed, readSnoozed);
  if (!show || hidden || isSnoozed) return null;
  const open = () => router.push(DASHCAM_AIM_HREF);
  return (
    <Card
      onPress={open}
      accessibilityLabel={`${copy.homeTitle}. ${copy.homeBody}`}
      accessibilityHint={copy.homeHint}
      // VoiceOver reads the card as one button, so its ✕ is an action on it too.
      accessibilityActions={[{ name: 'activate' }, { name: 'dismiss', label: copy.homeNotNow }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'activate') open();
        else if (e.nativeEvent.actionName === 'dismiss') setSnoozed(true);
      }}
      testID="home-dashpal-reaim"
    >
      <View style={{ flexDirection: 'row', gap: th.space.sm }}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: th.colors.warning }} testID="home-dashpal-reaim-dot" />
            <Text variant="headline">{copy.homeTitle}</Text>
          </View>
          <Text variant="callout" tone="muted" style={{ marginTop: th.space.xs }}>
            {copy.homeBody}
          </Text>
        </View>
        <IconButton icon="close" accessibilityLabel={copy.homeNotNow} onPress={() => setSnoozed(true)} style={{ alignSelf: 'flex-start' }} testID="home-dashpal-reaim-dismiss" />
      </View>
    </Card>
  );
}

import type { Href } from 'expo-router';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { Card, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../copy';
import type { DashcamState } from '../runtime';
import { useDashcamSelector } from './useDashcam';

const copy = dashpalCopy.screen.reaim;

/** Settings › DashPal with its camera view open (`app/(app)/settings/dashcam.tsx` reads `aim`). */
export const DASHCAM_AIM_HREF = { pathname: '/settings/dashcam', params: { aim: '1' } } as Href;

const selectReaim = (s: DashcamState | null): boolean => s?.reaim === true && s.link.paired !== null;

/**
 * Home's reminder that the paired DashPal's camera needs adjusting (its STATUS bit 7, kept while the
 * DashPal is off): a tap opens Settings › DashPal with the camera view. No dismiss: it goes when the
 * DashPal says its camera is fine again. Never while a drive is open (`hidden`).
 */
export function ReaimCard({ hidden = false }: { hidden?: boolean }) {
  const th = useTheme();
  const router = useRouter();
  const show = useDashcamSelector(selectReaim);
  if (!show || hidden) return null;
  return (
    <Card
      onPress={() => router.push(DASHCAM_AIM_HREF)}
      accessibilityLabel={`${copy.homeTitle}. ${copy.homeBody}`}
      accessibilityHint={copy.homeHint}
      testID="home-dashpal-reaim"
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: th.colors.warning }} testID="home-dashpal-reaim-dot" />
        <Text variant="headline">{copy.homeTitle}</Text>
      </View>
      <Text variant="callout" tone="muted" style={{ marginTop: th.space.xs }}>
        {copy.homeBody}
      </Text>
    </Card>
  );
}

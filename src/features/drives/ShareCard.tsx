import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import { LinearGradient } from 'expo-linear-gradient';
import { forwardRef, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import type { LatLng } from '@/lib/geo';
import { Banner, Button, Sheet, Text, ThemeProvider, tokens, useTheme } from '@/ui';

import { formatDay, formatDuration, formatMiles, signedPoints } from './format';
import { RouteSketch } from './RouteSketch';

export type ShareCardData = {
  startedAt: number;
  points: readonly LatLng[];
  miles: number;
  durationS: number;
  /** Net points; null when the drive has no score. */
  net: number | null;
  safetyRating: number | null;
  clean: boolean;
};

const GOLD = tokens.color.dark.primary;
const NAVY = ['#003566', '#001D3D'] as const;
const W = 320;
const H = 400;

function Fact({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <View style={{ flexBasis: '50%', paddingVertical: 8 }}>
      <Text variant="label" tone="muted">
        {label}
      </Text>
      <Text variant="stat" testID={testID} style={{ fontVariant: ['tabular-nums'] }}>
        {value}
      </Text>
    </View>
  );
}

/**
 * The Strava-style image: the (already privacy-trimmed) route in gold on navy, distance, time,
 * points, Safety Rating and a clean badge. It never shows a speed.
 */
export const ShareCard = forwardRef<View, { data: ShareCardData }>(function ShareCard({ data }, ref) {
  return (
    <ThemeProvider scheme="dark">
      <View ref={ref} collapsable={false} testID="share-card" style={{ width: W, height: H, borderRadius: 24, overflow: 'hidden', padding: 20 }}>
        <LinearGradient colors={NAVY} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text variant="title3" style={{ color: GOLD, fontStyle: 'italic' }}>
            RoadWise
          </Text>
          <Text variant="footnote" tone="muted">
            {formatDay(data.startedAt)}
          </Text>
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <RouteSketch points={data.points} size={180} stroke={GOLD} strokeWidth={5} background="transparent" />
          {data.clean ? (
            <View
              testID="share-clean"
              style={{
                position: 'absolute',
                right: 0,
                top: 4,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: 999,
                backgroundColor: GOLD,
              }}
            >
              <Ionicons name="checkmark-circle" size={14} color={tokens.color.dark.onPrimary} />
              <Text variant="label" style={{ color: tokens.color.dark.onPrimary }}>
                Clean drive
              </Text>
            </View>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          <Fact label="Distance" value={formatMiles(data.miles)} />
          <Fact label="Time" value={formatDuration(data.durationS)} />
          <Fact label="Points" value={data.net === null ? '—' : signedPoints(data.net)} testID="share-points" />
          <Fact label="Safety Rating" value={data.safetyRating === null ? '—' : String(Math.round(data.safetyRating))} />
        </View>
      </View>
    </ThemeProvider>
  );
});

/** Preview the card, then hand the image to the system share sheet. */
export function ShareSheet({ visible, data, onClose }: { visible: boolean; data: ShareCardData; onClose: () => void }) {
  const t = useTheme();
  const card = useRef<View>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');

  const share = async () => {
    setState('busy');
    try {
      if (!(await Sharing.isAvailableAsync())) throw new Error('sharing unavailable');
      const uri = await captureRef(card, { format: 'png', quality: 1, result: 'tmpfile' });
      await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share your drive', UTI: 'public.png' });
      setState('idle');
    } catch {
      setState('error');
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Share your drive" scroll testID="share-sheet">
      <View style={{ gap: t.space.lg, alignItems: 'center' }}>
        <ShareCard ref={card} data={data} />
        <Text variant="footnote" tone="muted" style={{ textAlign: 'center' }}>
          Your route is trimmed at the ends and inside privacy zones. Speeds are never shown.
        </Text>
        {state === 'error' ? <Banner tone="danger" message="Couldn't share the image. Try again." /> : null}
        <Button label="Share image" icon="share-outline" onPress={share} loading={state === 'busy'} style={{ alignSelf: 'stretch' }} testID="share-image" />
      </View>
    </Sheet>
  );
}

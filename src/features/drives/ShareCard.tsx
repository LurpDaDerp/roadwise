import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import { LinearGradient } from 'expo-linear-gradient';
import { forwardRef, useRef, useState } from 'react';
import { Text as RNText, StyleSheet, View, type TextStyle } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import { blockedDuringDrive } from '@/drive/leave';
import { formatRating } from '@/lib/rating';
import { formatDistance, type Units } from '@/lib/units';
import { Banner, Button, Sheet, Text, ThemeProvider, tokens, useTheme, type TypeVariant } from '@/ui';

import { formatDay, formatDuration, signedPoints } from './format';
import type { Runs } from './route';
import { RouteSketch } from './RouteSketch';

export type ShareCardData = {
  startedAt: number;
  /** The route's visible runs, each drawn apart (`decodeRoute`). */
  runs: Runs;
  miles: number;
  durationS: number;
  /** Net points; null when the drive has no score. */
  net: number | null;
  safetyRating: number | null;
  /** Under 25 mi in 30 days: the card says "Unranked", never a number. */
  ranked: boolean;
  clean: boolean;
  /** The driver's distance units. */
  units: Units;
};

const GOLD = tokens.color.dark.primary;
const NAVY = ['#003566', '#001D3D'] as const;
const W = 320;
const H = 400;

/**
 * Text on the captured card. The card is a fixed-size image, so its type never follows Dynamic
 * Type (the shared PNG would clip); everything else on screen still does.
 */
function CardText({ variant, tone = 'default', style, children, testID }: { variant: TypeVariant; tone?: 'default' | 'muted'; style?: TextStyle; children: React.ReactNode; testID?: string }) {
  const t = useTheme();
  const s = t.type[variant];
  const base: TextStyle = {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    color: tone === 'muted' ? t.colors.textMuted : t.colors.text,
    ...(s.fontWeight ? { fontWeight: s.fontWeight } : null),
    ...(s.letterSpacing !== undefined ? { letterSpacing: s.letterSpacing } : null),
    ...(s.fontVariant ? { fontVariant: s.fontVariant } : null),
    ...(s.textTransform ? { textTransform: s.textTransform } : null),
  };
  return (
    <RNText allowFontScaling={false} maxFontSizeMultiplier={1} style={[base, style]} testID={testID}>
      {children}
    </RNText>
  );
}

function Fact({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <View style={{ flexBasis: '50%', paddingVertical: 8 }}>
      <CardText variant="label" tone="muted">
        {label}
      </CardText>
      <CardText variant="stat" testID={testID}>
        {value}
      </CardText>
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
          <CardText variant="title3" style={{ color: GOLD, fontStyle: 'italic' }}>
            RoadWise
          </CardText>
          <CardText variant="footnote" tone="muted">
            {formatDay(data.startedAt)}
          </CardText>
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <RouteSketch runs={data.runs} size={180} stroke={GOLD} strokeWidth={5} background="transparent" />
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
              <CardText variant="label" style={{ color: tokens.color.dark.onPrimary }}>
                Clean drive
              </CardText>
            </View>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          <Fact label="Distance" value={formatDistance(data.miles, data.units)} />
          <Fact label="Time" value={formatDuration(data.durationS)} />
          <Fact label="Points" value={data.net === null ? '—' : signedPoints(data.net)} testID="share-points" />
          <Fact label="Safety Rating" value={formatRating(data.safetyRating, data.ranked)} testID="share-rating" />
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
    // A share target opens outside RoadWise: not during a drive (src/drive/leave.ts).
    if (blockedDuringDrive()) return;
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

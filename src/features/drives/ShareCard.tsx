import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import { LinearGradient } from 'expo-linear-gradient';
import { forwardRef, useCallback, useMemo, useRef, useState } from 'react';
import { Text as RNText, StyleSheet, View, type TextStyle } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import { blockedDuringDrive } from '@/drive/leave';
import { formatDistance, type Units } from '@/lib/units';
import { Banner, Button, SceneScope, Sheet, Text, ToggleRow, tokens, useTheme, type TypeVariant } from '@/ui';

import { formatDay, formatDuration, signedPoints } from './format';
import type { Runs } from './route';
import { RouteSketch } from './RouteSketch';
import { mapOffered, ShareMapBackdrop, type Box, type MapStatus } from './ShareMap';

export type ShareCardData = {
  startedAt: number;
  /** The route's visible runs, each drawn apart (`decodeRoute`). */
  runs: Runs;
  miles: number;
  durationS: number;
  /** Net points; null when the drive has no score. */
  net: number | null;
  /** The drive score out of 100 (`driveScoreOf`); null when the drive has no total, and the card says "—". */
  score: number | null;
  clean: boolean;
  /** The driver's distance units. */
  units: Units;
};

/** Gold, the reward colour, carries the route and the clean badge on the card. */
const GOLD = tokens.color.dark.gold;
const W = 320;
const H = 400;
/** With the map on: where the route sits, clear of the header and the facts. */
const MAP_BOX: Box = { left: 24, top: 72, right: W - 24, bottom: 228 };
/** With the map on: the opaque sky behind the header (top) and the facts (bottom), and its fade. */
const MAP_BAND = { top: 60, bottom: 156, fade: 40 };

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
 * The Strava-style image: the (already privacy-trimmed) route in gold on the hour's sky (the same
 * scene as the app's hero cards), distance, time, points, the drive score and a clean badge. It
 * never shows a speed.
 */
export const ShareCard = forwardRef<
  View,
  {
    data: ShareCardData;
    /**
     * Show the map of the route's area behind the card (`ShareMapBackdrop`): a new `attempt` loads
     * it afresh, and `onStatus` hears when it is in the card or has failed.
     */
    map?: { attempt: number; onStatus: (s: MapStatus) => void } | null;
  }
>(function ShareCard({ data, map }, ref) {
  const scene = useTheme().sky.scene;
  return (
    <SceneScope>
      <View ref={ref} collapsable={false} testID="share-card" style={{ width: W, height: H, borderRadius: 28, overflow: 'hidden', padding: 20 }}>
        <LinearGradient colors={scene} start={{ x: 0.1, y: 0 }} end={{ x: 0.9, y: 1 }} style={StyleSheet.absoluteFill} />
        {map ? (
          <ShareMapBackdrop
            key={map.attempt}
            runs={data.runs}
            width={W}
            height={H}
            box={MAP_BOX}
            scene={scene}
            stroke={GOLD}
            strokeWidth={5}
            band={MAP_BAND}
            onStatus={map.onStatus}
          />
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <CardText variant="title3" style={{ fontStyle: 'italic' }}>
            RoadWise
          </CardText>
          <CardText variant="footnote" tone="muted">
            {formatDay(data.startedAt)}
          </CardText>
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          {map ? null : <RouteSketch runs={data.runs} size={180} stroke={GOLD} strokeWidth={5} background="transparent" />}
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
              <Ionicons name="checkmark-circle" size={14} color={tokens.color.dark.onGold} />
              <CardText variant="label" style={{ color: tokens.color.dark.onGold }}>
                Clean drive
              </CardText>
            </View>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          <Fact label="Distance" value={formatDistance(data.miles, data.units)} />
          <Fact label="Time" value={formatDuration(data.durationS)} />
          <Fact label="Points" value={data.net === null ? '—' : signedPoints(data.net)} testID="share-points" />
          <Fact label="Drive score" value={data.score === null ? '—' : String(data.score)} testID="share-score" />
        </View>
        {map ? (
          <CardText variant="caption" tone="muted" style={{ position: 'absolute', right: 20, bottom: 4, fontSize: 9, lineHeight: 12 }}>
            Map © Apple
          </CardText>
        ) : null}
      </View>
    </SceneScope>
  );
});

/**
 * Preview the card, then hand the image to the system share sheet. On iOS, "Show map" puts the
 * map of the route's area behind the card; it is off each time the sheet opens. With it on, Share
 * waits for the map, and says so if the map can't load rather than share a card without it.
 */
export function ShareSheet({ visible, data, onClose }: { visible: boolean; data: ShareCardData; onClose: () => void }) {
  const t = useTheme();
  const card = useRef<View>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'error' | 'mapError'>('idle');
  const offered = useMemo(() => mapOffered(data.runs, W, H, MAP_BOX), [data.runs]);
  const [withMap, setWithMap] = useState(false);
  const [mapStatus, setMapStatus] = useState<MapStatus>('loading');
  const [attempt, setAttempt] = useState(0);
  const status = useRef<MapStatus>('loading');
  const waiters = useRef<((ready: boolean) => void)[]>([]);

  // Off every time the sheet opens.
  const [open, setOpen] = useState(visible);
  if (open !== visible) {
    setOpen(visible);
    if (visible) {
      setWithMap(false);
      setState('idle');
    }
  }

  const onMapStatus = useCallback((s: MapStatus) => {
    status.current = s;
    setMapStatus(s);
    if (s === 'loading') return;
    const ws = waiters.current;
    waiters.current = [];
    for (const w of ws) w(s === 'ready');
  }, []);

  const loadMap = () => {
    onMapStatus('loading');
    setAttempt((a) => a + 1);
  };

  /** True once the map is in the card; false when it failed. A failed map is tried again first. */
  const mapReady = (): Promise<boolean> => {
    if (status.current === 'ready') return Promise.resolve(true);
    if (status.current === 'failed') loadMap();
    return new Promise((resolve) => waiters.current.push(resolve));
  };

  const share = async () => {
    // A share target opens outside RoadWise: not during a drive (src/drive/leave.ts).
    if (blockedDuringDrive()) return;
    setState('busy');
    try {
      if (withMap && offered && !(await mapReady())) {
        setState('mapError');
        return;
      }
      if (!(await Sharing.isAvailableAsync())) throw new Error('sharing unavailable');
      const uri = await captureRef(card, { format: 'png', quality: 1, result: 'tmpfile' });
      await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share your drive', UTI: 'public.png' });
      setState('idle');
    } catch {
      setState('error');
    }
  };

  const map = offered && withMap;
  const mapFailed = map && (state === 'mapError' || (mapStatus === 'failed' && state !== 'busy'));
  return (
    <Sheet visible={visible} onClose={onClose} title="Share your drive" scroll testID="share-sheet">
      <View style={{ gap: t.space.lg, alignItems: 'center' }}>
        <ShareCard ref={card} data={data} map={map ? { attempt, onStatus: onMapStatus } : null} />
        {offered ? (
          <View style={{ alignSelf: 'stretch' }}>
            <ToggleRow
              title="Show map"
              value={withMap}
              disabled={state === 'busy'}
              onValueChange={(on) => {
                setWithMap(on);
                setState('idle');
                if (on) loadMap();
              }}
              testID="share-map-toggle"
            />
          </View>
        ) : null}
        <Text variant="footnote" tone="muted" style={{ textAlign: 'center' }}>
          Your route is trimmed at the ends and inside privacy zones. Speeds are never shown.
        </Text>
        {map ? (
          <Text variant="footnote" tone="muted" style={{ textAlign: 'center' }} testID="share-map-note">
            The map shows the area around your trimmed route.
          </Text>
        ) : null}
        {mapFailed ? <Banner tone="danger" message="Couldn't load the map. Turn off Show map or try again." testID="share-map-error" /> : null}
        {state === 'error' ? <Banner tone="danger" message="Couldn't share the image. Try again." /> : null}
        <Button label="Share image" icon="share-outline" onPress={share} loading={state === 'busy'} style={{ alignSelf: 'stretch' }} testID="share-image" />
      </View>
    </Sheet>
  );
}

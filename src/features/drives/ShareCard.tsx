import type { MeritTier } from '@scoring';
import * as Sharing from 'expo-sharing';
import { LinearGradient } from 'expo-linear-gradient';
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text as RNText, StyleSheet, View, type TextStyle } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import type { Units } from '@/lib/units';
import { mix } from '@/ui/sky/color';
import { Banner, Button, SceneScope, Sheet, Text, ToggleRow, tokens, useTheme, withAlpha } from '@/ui';

import { MeritFacts } from './MeritFacts';
import { meritCardStops } from './merit';
import type { Runs } from './route';
import { RouteSketch } from './RouteSketch';
import { mapOffered, ShareMapBackdrop, type Band, type Box, type MapStatus } from './ShareMap';

export type ShareCardData = {
  /** The route's visible runs, each drawn apart (`decodeRoute`). */
  runs: Runs;
  miles: number;
  durationS: number;
  /** The drive score out of 100 (the recap's); null when the drive has none, and the card says "—". */
  score: number | null;
  /** `driveMerit(score, miles)`; null with no score. */
  tier: MeritTier | null;
  /** The driver's distance units. */
  units: Units;
};

/** Gold, the reward colour, carries the route on the card. */
const GOLD = tokens.color.dark.gold;
/** The ink on a merit-coloured card. */
const WHITE = '#FFFFFF';
const W = 320;
const H = 400;
/**
 * With the map on: where the route sits. The wordmark ends near y = 44 and the facts' text starts
 * near y = 252, and the sky fades the map out in between (`MAP_BAND`), so the box keeps to the
 * clearly visible middle: about 40 pt of eased fade above the route and 50 pt below it, where the
 * sky covers it less than half.
 */
export const MAP_BOX: Box = { left: 24, top: 82, right: W - 24, bottom: 202 };
/**
 * With the map on: how the sky covers the map (card points from the top). Opaque to y = 40 behind
 * the wordmark and eased out to nothing by 104; nothing before 150, eased in to opaque by 256, just
 * behind the facts (their text starts near 252, over 99 % sky), and solid to the bottom.
 */
export const MAP_BAND: Band = { topSolid: 40, topEnd: 104, bottomStart: 150, bottomSolid: 256 };

/** Text on the captured card: a fixed-size image, so its type never follows Dynamic Type (the shared PNG would clip). */
function CardText({ children, style, testID }: { children: React.ReactNode; style?: TextStyle; testID?: string }) {
  const t = useTheme();
  const s = t.type.title3;
  return (
    <RNText
      allowFontScaling={false}
      maxFontSizeMultiplier={1}
      style={[{ fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight, color: t.colors.text }, style]}
      testID={testID}
    >
      {children}
    </RNText>
  );
}

/**
 * The Strava-style image: the "RoadWise" wordmark in white, a dark gradient of the drive's merit
 * colour (`meritCardStops`: the merit tag's hue, deepened; a drive with no tier keeps the hour's sky,
 * the same scene as the app's hero cards), the (already privacy-trimmed) route in gold or, with "Show map" on, the map of its area,
 * then the drive's three facts as the recap's hero shows them (`MeritFacts`): the tier's icon beside
 * the score, then distance and time, in the tier's colour. Nothing else: no date, place, event
 * count, rating, badge or tier name, and never a speed.
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
  const t = useTheme();
  const scene = t.sky.scene;
  const tiered = data.tier !== null;
  const stops = data.tier === null ? scene : meritCardStops(data.tier);
  // The map's backdrop wants three stops (its middle one washes the map): a merit gradient's midpoint.
  const mapScene: readonly [string, string, string] = data.tier === null ? scene : [stops[0]!, mix(stops[0]!, stops[1]!, 0.5), stops[1]!];
  return (
    <SceneScope>
      <View ref={ref} collapsable={false} testID="share-card" style={{ width: W, height: H, borderRadius: 28, overflow: 'hidden', padding: 20 }}>
        <LinearGradient colors={stops} start={{ x: 0.1, y: 0 }} end={{ x: 0.9, y: 1 }} style={StyleSheet.absoluteFill} testID="share-card-bg" />
        {map ? (
          <ShareMapBackdrop
            key={map.attempt}
            runs={data.runs}
            width={W}
            height={H}
            box={MAP_BOX}
            scene={mapScene}
            stroke={GOLD}
            strokeWidth={5}
            band={MAP_BAND}
            onStatus={map.onStatus}
          />
        ) : null}
        <CardText style={{ fontStyle: 'italic', ...(tiered ? { color: WHITE } : null) }} testID="share-wordmark">
          RoadWise
        </CardText>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          {map ? null : <RouteSketch runs={data.runs} size={180} stroke={GOLD} strokeWidth={5} background="transparent" />}
        </View>
        <MeritFacts
          size="card"
          score={data.score}
          miles={data.miles}
          durationS={data.durationS}
          units={data.units}
          tier={data.tier}
          surfaces={stops}
          plainInk={tiered ? WHITE : t.onScene.text}
          testID="share-facts"
        />
        {map ? (
          <CardText style={{ position: 'absolute', right: 20, bottom: 4, fontSize: 9, lineHeight: 12, fontStyle: 'normal', color: tiered ? withAlpha(WHITE, 0.7) : t.onScene.textMuted }}>Map © Apple</CardText>
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
  /** Bumped when the sheet opens or closes and when Show map goes off: a share begun before stops quietly. */
  const shareGen = useRef(0);

  // Off every time the sheet opens.
  const [open, setOpen] = useState(visible);
  if (open !== visible) {
    setOpen(visible);
    if (visible) {
      setWithMap(false);
      setState('idle');
    }
  }

  /** A share waiting for the map is let go (its map is gone): it never resumes on a later map. */
  const dropWaiters = useCallback(() => {
    shareGen.current += 1;
    const ws = waiters.current;
    waiters.current = [];
    for (const w of ws) w(false);
  }, []);
  useEffect(dropWaiters, [visible, dropWaiters]);

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
    const gen = shareGen.current;
    const stale = () => gen !== shareGen.current;
    setState('busy');
    try {
      if (withMap && offered) {
        const ready = await mapReady();
        if (stale()) return;
        if (!ready) {
          setState('mapError');
          return;
        }
      }
      const available = await Sharing.isAvailableAsync();
      if (stale()) return;
      if (!available) throw new Error('sharing unavailable');
      const uri = await captureRef(card, { format: 'png', quality: 1, result: 'tmpfile' });
      if (stale()) return;
      await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share your drive', UTI: 'public.png' });
      if (!stale()) setState('idle');
    } catch {
      if (!stale()) setState('error');
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
                else dropWaiters();
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

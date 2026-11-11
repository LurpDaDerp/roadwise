import { Ionicons } from '@expo/vector-icons';
import type { RoadStamp } from '@scoring';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { roadCopy, roadSpoken, weatherAction, weatherCopy, weatherLabel, weatherTitle } from '@/features/weather/copy';
import type { DangerAlert } from '@/features/weather/danger';
import type { Units } from '@/lib/units';
import { fontFamilies } from '@/ui/fonts';
import { HUD_MIN_TARGET_PT, type HudPalette } from '@/ui/drive';

/** The ✕'s drawn disc; its touch target reaches the HUD's 64 pt through the hit slop. */
export const WEATHER_CLOSE_PT = 34;

const OUTLINE_PT = 2;
const BAR_MIN_PT = 40;
/** The ✕ sits this far inside the outline from the card's top right corner (less in a card too short for it). */
const CLOSE_INSET_PT = 5;
/**
 * The two lines' type: the full card (its slot under the halo, or the band), and a compact window's narrow band between the sign
 * and the navigation button. The lines are whole points and the compact pair (20 + 16) fills the words' 36 pt box, so every Text
 * frame lands on whole points in any slot; the texts never scale themselves (a long line gets a tail ellipsis).
 */
const TYPE = {
  full: { title: 20, titleLine: 24, action: 15, actionLine: 18, pad: 1 },
  compact: { title: 16, titleLine: 20, action: 13, actionLine: 16, pad: 0 },
} as const;

/** The card's height: its two lines, padding and outline, or its floor (its slot or the band must hold it). */
export function weatherBannerPt(compact: boolean): number {
  const t = TYPE[compact ? 'compact' : 'full'];
  return Math.max(BAR_MIN_PT, t.titleLine + t.actionLine + 2 * t.pad + 2 * OUTLINE_PT);
}

/** The road state while it tightens the lines, and the road's title ("Wet roads"). */
export interface BannerRoad {
  road: RoadStamp;
  title: string;
}

/**
 * The weather card on the driving screen (plan D14): a yellow outline as on Home's card, the warning
 * glyph, the alert's title (one to three words; the road's, "Wet roads", with no alert) and under it
 * the warning, what to do in four words at most, or "Stricter limits now" while the road state
 * tightens the lines, with the ✕ in the top right corner. It fills its slot's width. The full line is
 * spoken with it (while the lines are tightened, what counts sooner). Its ✕ shows and takes a touch
 * at any speed, moving or stopped: with End and the navigation button, the only touch targets while
 * moving.
 */
function WeatherBannerView({
  alert,
  road = null,
  units,
  palette: p,
  compact,
  onDismiss,
}: {
  /** The alert the card names; null for a road state alone (then `road` is set). */
  alert: DangerAlert | null;
  /** The road state while it tightens the lines, or null (the default). */
  road?: BannerRoad | null;
  units: Units;
  palette: HudPalette;
  /** A compact window's narrow band: smaller type. */
  compact: boolean;
  onDismiss(): void;
}) {
  const slop = (HUD_MIN_TARGET_PT - WEATHER_CLOSE_PT) / 2;
  const t = TYPE[compact ? 'compact' : 'full'];
  // Inside the outline: the card's inner height less the disc, split evenly when it can't spare the inset.
  const inset = Math.min(CLOSE_INSET_PT, Math.max(0, (weatherBannerPt(compact) - 2 * OUTLINE_PT - WEATHER_CLOSE_PT) / 2));
  const title = alert !== null ? weatherTitle(alert) : (road?.title ?? '');
  const action = road !== null ? roadCopy.stricter : alert !== null ? weatherAction(alert) : '';
  const label = road !== null ? roadSpoken(title, road.road) : alert !== null ? weatherLabel(alert, units) : '';
  return (
    <View testID="hud-weather" style={[styles.card, { backgroundColor: p.chrome, borderColor: p.minor, paddingVertical: t.pad }]}>
      <View accessible accessibilityRole="alert" accessibilityLabel={label} style={styles.words}>
        {/* The HUD's warning yellow: this card shows only when the weather is dangerous or tightens the lines. */}
        <Ionicons testID="hud-weather-icon" name="warning" size={22} color={p.minor} />
        <View style={styles.lines}>
          <Text
            allowFontScaling={false}
            numberOfLines={1}
            style={[styles.title, { color: p.ink, fontSize: t.title, lineHeight: t.titleLine }]}
          >
            {title}
          </Text>
          <Text
            testID="hud-weather-action"
            allowFontScaling={false}
            numberOfLines={1}
            style={[styles.action, { color: p.inkMuted, fontSize: t.action, lineHeight: t.actionLine }]}
          >
            {action}
          </Text>
        </View>
      </View>
      <Pressable
        testID="hud-weather-close"
        accessibilityRole="button"
        accessibilityLabel={weatherCopy.dismiss}
        accessibilityHint={weatherCopy.dismissDriveHint}
        hitSlop={slop}
        onPress={onDismiss}
        style={({ pressed }) => [styles.close, { top: inset, right: inset, borderColor: p.chromeEdge, opacity: pressed ? 0.7 : 1 }]}
      >
        <Ionicons name="close" size={22} color={p.ink} />
      </Pressable>
    </View>
  );
}

export const WeatherBanner = memo(WeatherBannerView);

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    minHeight: BAR_MIN_PT,
    paddingLeft: 14,
    // Room for the ✕ in the corner.
    paddingRight: CLOSE_INSET_PT + WEATHER_CLOSE_PT + 8,
    borderRadius: 16,
    borderCurve: 'continuous',
    borderWidth: OUTLINE_PT,
  },
  words: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 },
  lines: { flexShrink: 1 },
  title: { fontFamily: fontFamilies.fieldBold },
  action: { fontFamily: fontFamilies.field },
  close: {
    position: 'absolute',
    width: WEATHER_CLOSE_PT,
    height: WEATHER_CLOSE_PT,
    borderRadius: WEATHER_CLOSE_PT / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

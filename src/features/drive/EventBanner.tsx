import { MaterialCommunityIcons } from '@expo/vector-icons';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AlertKind, AlertLevel } from '@/core/alerts/types';
import type { DriveState, HarshEventKind } from '@/drive/host';
import { fontFamilies } from '@/ui/fonts';
import { type HaloLevel, haloColor, hudPalette } from '@/ui/drive';

import { hudCopy } from './hudCopy';

/** How long the banner stays: long enough to read at a glance, gone before it becomes clutter. */
export const EVENT_BANNER_MS = 4_000;

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

export interface BannerEvent {
  /** The event's own id: a repeat of the same event never re-shows the banner. */
  key: string;
  icon: IconName;
  words: string;
  /** A smaller second line, where the event has one ("2 h driving"). */
  detail?: string;
  tone: Exclude<HaloLevel, 'calm'>;
}

/** One drawn mark per alert kind. States a condition, never a manoeuvre (SR6). */
const ALERT_ICON: Record<AlertKind, IconName> = {
  speeding: 'speedometer',
  phone: 'cellphone',
  eyes_off: 'eye-off',
  drowsy: 'sleep',
  break: 'coffee',
};

const HARSH_ICON: Record<HarshEventKind, IconName> = {
  braking: 'car-brake-alert',
  accel: 'speedometer',
  cornering: 'steering',
};

/** The banner for an alert decision. The break suggestion says how long the drive has run. */
export function alertBanner(
  a: { id: string; kind: AlertKind; level: AlertLevel },
  drivingMs: number | null
): BannerEvent {
  const event: BannerEvent = {
    key: `alert:${a.id}`,
    icon: ALERT_ICON[a.kind],
    words: hudCopy.event[a.kind],
    tone: a.level === 3 ? 'critical' : 'attention',
  };
  if (a.kind === 'break' && drivingMs !== null && drivingMs > 0) {
    event.detail = hudCopy.event.breakDetail(Math.max(1, Math.round(drivingMs / 3_600_000)));
  }
  return event;
}

/** The banner for a harsh-driving event: always attention, never critical. */
export function harshBanner(h: { id: string; kind: HarshEventKind }): BannerEvent {
  return {
    key: `harsh:${h.id}`,
    icon: HARSH_ICON[h.kind],
    words: hudCopy.event[h.kind],
    tone: 'attention',
  };
}

/**
 * The banner a snapshot calls for, or null: the later of the alert now showing and the last harsh
 * event, while it is younger than `EVENT_BANNER_MS` on the row clock — `lastRowTs`, the clock
 * both are stamped on — so the host's longer L3 window never keeps it up, and a harsh event the
 * HUD only meets long after it happened is not news. No timer: the next row ages it out. A pure
 * function of the snapshot, so `useDrive(bannerOf)` re-renders only when the banner changes.
 */
export function bannerOf(
  s: Pick<DriveState, 'activeAlert' | 'harshEvent' | 'lastRowTs' | 'startedAt'>
): BannerEvent | null {
  const now = s.lastRowTs;
  if (now === null) return null;
  const alert = s.activeAlert !== null && now - s.activeAlert.ts < EVENT_BANNER_MS ? s.activeAlert : null;
  const harsh = s.harshEvent != null && now - s.harshEvent.ts < EVENT_BANNER_MS ? s.harshEvent : null;
  if (alert !== null && (harsh === null || alert.ts >= harsh.ts)) {
    return alertBanner(alert, s.startedAt === null ? null : now - s.startedAt);
  }
  return harsh === null ? null : harshBanner(harsh);
}

const WORDS_PT = 32;
const DETAIL_PT = 18;

/**
 * The event banner: a band across the top of the HUD in the attention or critical colour, a drawn
 * mark and at most three words. It takes no touch and makes no motion; it is there for a few
 * seconds and then it is not.
 */
export const EventBanner = memo(function EventBanner({
  event,
  night,
}: {
  event: BannerEvent;
  night: boolean;
}) {
  const insets = useSafeAreaInsets();
  const p = hudPalette(night);
  const face = haloColor(p, event.tone);
  const ink = event.tone === 'critical' ? p.criticalInk : p.attentionInk;
  return (
    <View
      testID="hud-banner"
      pointerEvents="none"
      accessible
      accessibilityRole="alert"
      accessibilityLabel={event.detail ? `${event.words}. ${event.detail}` : event.words}
      style={[
        styles.band,
        {
          backgroundColor: face,
          paddingTop: 16 + insets.top,
          paddingLeft: 24 + insets.left,
          paddingRight: 24 + insets.right,
        },
      ]}
    >
      <MaterialCommunityIcons testID="hud-banner-icon" name={event.icon} size={44} color={ink} />
      <View style={styles.text}>
        <Text
          testID="hud-banner-words"
          allowFontScaling={false}
          numberOfLines={1}
          adjustsFontSizeToFit
          style={[styles.words, { color: ink }]}
        >
          {event.words}
        </Text>
        {event.detail ? (
          <Text
            testID="hud-banner-detail"
            allowFontScaling={false}
            numberOfLines={1}
            style={[styles.detail, { color: ink }]}
          >
            {event.detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  band: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    minHeight: 96,
    paddingBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  text: { flexShrink: 1, alignItems: 'flex-start' },
  words: {
    fontFamily: fontFamilies.fieldBold,
    fontSize: WORDS_PT,
    lineHeight: Math.round(WORDS_PT * 1.15),
  },
  detail: {
    fontFamily: fontFamilies.field,
    fontSize: DETAIL_PT,
    lineHeight: Math.round(DETAIL_PT * 1.25),
  },
});

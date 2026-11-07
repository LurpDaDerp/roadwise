import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { useDataSource, useDb } from '@/data/queries/context';
import { useWrappedArchive, type WrappedArchiveEntry } from '@/data/server/wrapped';
import { wrappedMonthHref } from '@/features/social/links';
import { deviceZone } from '@/lib/deviceZone';
import { Card, IconButton, Text, useTheme, withAlpha } from '@/ui';

import { ArchetypeIcon } from './ArchetypeIcon';
import { archetypePattern, archetypeStops } from './archetypes';
import { wrappedCopy as copy } from './copy';
import { homeCardEntry, inCardWindow, monthName, WRAPPED_CARD_DISMISSED_KEY } from './month';

/** The archetype colour's wash over the card face: a touch more on the dark card. */
export const WASH_ALPHA: Readonly<Record<'light' | 'dark', number>> = { light: 0.12, dark: 0.2 };

/** The card itself: the archetype's colour washed behind it, its icon on a disc of that colour, the ✕ top right. */
export function WrappedCardView({ entry, onOpen, onDismiss }: { entry: WrappedArchiveEntry; onOpen: () => void; onDismiss: () => void }) {
  const t = useTheme();
  const stops = archetypeStops(entry.archetype);
  const title = copy.home.title(monthName(entry.month));
  return (
    <Card
      onPress={onOpen}
      accessibilityLabel={`${title}. ${copy.home.body}`}
      accessibilityHint={copy.home.hint}
      // VoiceOver reads the card as one button, so its ✕ is an action on it too.
      accessibilityActions={[{ name: 'activate' }, { name: 'dismiss', label: copy.home.dismiss }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'activate') onOpen();
        else if (e.nativeEvent.actionName === 'dismiss') onDismiss();
      }}
      testID="home-wrapped"
    >
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(stops[0], WASH_ALPHA[t.scheme]) }]} testID="home-wrapped-wash" />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <ArchetypeIcon pattern={archetypePattern(entry.archetype)} size={48} disc={stops[0]} testID="home-wrapped-icon" />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="headline">{title}</Text>
          <Text variant="subhead" tone="muted">
            {copy.home.body}
          </Text>
        </View>
        <IconButton icon="close" accessibilityLabel={copy.home.dismiss} onPress={onDismiss} variant="plain" style={{ alignSelf: 'flex-start' }} testID="home-wrapped-dismiss" />
      </View>
    </Card>
  );
}

/**
 * Home's slot: last month's Wrapped from the 1st through the 7th (the phone's local days), once the
 * driver has one (3 or more scored drives that month), until its ✕ closes it (for that month; wiped
 * at sign-out). Never during a drive. The archive is asked for only on those days.
 */
export function HomeWrappedCard({ hidden }: { hidden: boolean }) {
  const router = useRouter();
  const db = useDb();
  const { now } = useDataSource();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const at = now();
  const zone = deviceZone();
  const open = !hidden && inCardWindow(at, zone);
  const archive = useWrappedArchive({ enabled: open });
  // undefined: not read yet (no flash of a card closed earlier).
  const [dismissed, setDismissed] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void settings
      .get<string>(WRAPPED_CARD_DISMISSED_KEY)
      .then((v) => live && setDismissed(typeof v === 'string' ? v : null))
      .catch(() => live && setDismissed(null));
    return () => {
      live = false;
    };
  }, [settings]);

  if (!open || dismissed === undefined) return null;
  const entry = homeCardEntry(at, zone, archive.data, dismissed);
  if (entry === null) return null;
  return (
    <WrappedCardView
      entry={entry}
      onOpen={() => router.push(wrappedMonthHref(entry.month))}
      onDismiss={() => {
        setDismissed(entry.month);
        void settings.set(WRAPPED_CARD_DISMISSED_KEY, entry.month).catch(() => {});
      }}
    />
  );
}

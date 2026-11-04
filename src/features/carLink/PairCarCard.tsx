// Home's car card (iPhone): once the same Bluetooth or CarPlay was connected for most of 2 of the
// last 3 drives (CarPlay after one), "Is <name> your car?" with Use it and Not my car, its ✕ in the
// top right corner closing it for good. Shown only while automatic drives are on and no car is
// paired; never while a drive records; never on Android. Pairing a car with nothing detected yet is
// a tile in Home's "Get set up" row.
import { Ionicons } from '@expo/vector-icons';
import type { Href } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';

import type { CarOutput } from '@drive-sense';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { autoDrivesOn, useAutoDrives } from '@/features/autoDrives/useAutoDrives';
import { Button, Card, IconButton, Text, useTheme } from '@/ui';

import { carCopy } from './copy';
import { CAR_CARD_DISMISSED_KEY, carSuggestion, outputName } from './model';
import { useCarLink } from './useCarLink';

const copy = carCopy.card;
/** Settings › Your car. */
export const CAR_HREF = '/settings/car' as Href;

function CarDisc() {
  const t = useTheme();
  return (
    <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accentFaint }}>
      <Ionicons name="car-sport" size={t.size.iconLg} color={t.colors.accent} accessible={false} />
    </View>
  );
}

/** The card itself: the car seen on recent drives, Use it and Not my car, the ✕ top right. */
export function PairCarCardView({
  suggestion,
  onUse,
  onNotMine,
  onDismiss,
}: {
  suggestion: CarOutput;
  onUse: () => void;
  onNotMine: () => void;
  onDismiss: () => void;
}) {
  const t = useTheme();
  const name = outputName(suggestion);
  return (
    <Card testID="home-car-ask">
      <View style={{ gap: t.space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
          <CarDisc />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="headline">{copy.askTitle(name)}</Text>
            <Text variant="subhead" tone="muted">
              {copy.askBody}
            </Text>
          </View>
          <IconButton icon="close" accessibilityLabel={copy.dismiss} onPress={onDismiss} variant="plain" style={{ alignSelf: 'flex-start' }} testID="home-car-dismiss" />
        </View>
        <View style={{ flexDirection: 'row', gap: t.space.sm }}>
          <Button label={copy.use} size="sm" onPress={onUse} testID="home-car-use" />
          <Button label={copy.notMine} size="sm" variant="secondary" onPress={onNotMine} testID="home-car-not-mine" />
        </View>
      </View>
    </Card>
  );
}

/** Home's slot: renders nothing unless a car was seen on recent drives (and the card applies). */
export function HomeCarCard({ hidden }: { hidden: boolean }) {
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const auto = useAutoDrives();
  const link = useCarLink();
  // null: not read yet (no flash of a card closed earlier).
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void settings
      .get<boolean>(CAR_CARD_DISMISSED_KEY)
      .then((v) => live && setDismissed(v === true))
      .catch(() => live && setDismissed(false));
    return () => {
      live = false;
    };
  }, [settings]);

  if (Platform.OS !== 'ios' || hidden || dismissed !== false || !autoDrivesOn(auto) || link.view.status !== 'ready') return null;
  const state = link.view.state;
  if (state.cars.length > 0) return null;
  const suggestion = carSuggestion(state);
  if (suggestion === null) return null;
  return (
    <PairCarCardView
      suggestion={suggestion}
      onUse={() => void link.pair(suggestion.uid)}
      onNotMine={() => void link.notMine(suggestion.uid)}
      onDismiss={() => {
        setDismissed(true);
        void settings.set(CAR_CARD_DISMISSED_KEY, true).catch(() => {});
      }}
    />
  );
}

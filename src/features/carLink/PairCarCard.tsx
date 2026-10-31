// Home's car card (iPhone): "Pair your car" while automatic drives are on and no car is paired, one
// tap to Settings › Your car; or, once the same Bluetooth or CarPlay was connected for most of 2 of
// the last 3 drives (CarPlay after one), "Is <name> your car?" with Use it and Not my car. Its ✕
// closes it for good. Never while a drive records; never on Android.
import { Ionicons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
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

/** The card itself: the generic prompt (`suggestion` null) or the learned one. */
export function PairCarCardView({
  suggestion,
  onOpen,
  onUse,
  onNotMine,
  onDismiss,
}: {
  suggestion: CarOutput | null;
  onOpen: () => void;
  onUse: () => void;
  onNotMine: () => void;
  onDismiss: () => void;
}) {
  const t = useTheme();
  const close = <IconButton icon="close" accessibilityLabel={copy.dismiss} onPress={onDismiss} variant="plain" testID="home-car-dismiss" />;
  if (suggestion === null) {
    return (
      <Card onPress={onOpen} accessibilityLabel={`${copy.title}. ${copy.body}`} accessibilityHint={copy.hint} testID="home-car">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
          <CarDisc />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="headline">{copy.title}</Text>
            <Text variant="subhead" tone="muted">
              {copy.body}
            </Text>
          </View>
          {close}
        </View>
      </Card>
    );
  }
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
          {close}
        </View>
        <View style={{ flexDirection: 'row', gap: t.space.sm }}>
          <Button label={copy.use} size="sm" onPress={onUse} testID="home-car-use" />
          <Button label={copy.notMine} size="sm" variant="secondary" onPress={onNotMine} testID="home-car-not-mine" />
        </View>
      </View>
    </Card>
  );
}

/** Home's slot: renders nothing unless the card applies. */
export function HomeCarCard({ hidden }: { hidden: boolean }) {
  const router = useRouter();
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
  return (
    <PairCarCardView
      suggestion={suggestion}
      onOpen={() => router.push(CAR_HREF)}
      onUse={() => {
        if (suggestion) void link.pair(suggestion.uid);
      }}
      onNotMine={() => {
        if (suggestion) void link.notMine(suggestion.uid);
      }}
      onDismiss={() => {
        setDismissed(true);
        void settings.set(CAR_CARD_DISMISSED_KEY, true).catch(() => {});
      }}
    />
  );
}

import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { SETTINGS_HREFS } from '@/features/settings/routes';
import { Card, IconButton, Text, useTheme } from '@/ui';

import { placesCopy } from './copy';
import { usePlacesCard } from './usePlaces';

const copy = placesCopy.card;

/** The card itself: the house in its disc, the title and line, Not now at the right. */
export function PlacesCardView({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  const t = useTheme();
  return (
    <Card onPress={onOpen} accessibilityLabel={`${copy.title}. ${copy.body}`} accessibilityHint={copy.hint} testID="home-places">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accentFaint }}>
          <Ionicons name="home" size={t.size.iconLg} color={t.colors.accent} accessible={false} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="headline">{copy.title}</Text>
          <Text variant="subhead" tone="muted">
            {copy.body}
          </Text>
        </View>
        <IconButton icon="close" accessibilityLabel={copy.dismiss} onPress={onDismiss} variant="plain" testID="home-places-dismiss" />
      </View>
    </Card>
  );
}

/**
 * Home's "Add your places" card: shown until a place is saved (anywhere: the card's own screen,
 * or Settings) or the card is closed with Not now, and never while a drive records. A tap opens
 * Settings › Places.
 */
export function HomePlacesCard({ hidden }: { hidden: boolean }) {
  const router = useRouter();
  const { show, dismiss, refetch } = usePlacesCard();
  // Gone at once on Not now, whatever a read already on its way says when it lands.
  const [gone, setGone] = useState(false);
  // A place saved a screen deeper takes the card down on the way back.
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch])
  );
  if (hidden || gone || !show) return null;
  return (
    <PlacesCardView
      onOpen={() => router.push(SETTINGS_HREFS.places)}
      onDismiss={() => {
        setGone(true);
        dismiss();
      }}
    />
  );
}

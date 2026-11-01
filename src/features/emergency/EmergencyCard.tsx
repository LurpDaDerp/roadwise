import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { SETTINGS_HREFS } from '@/features/settings/routes';
import { Card, IconButton, Text, useTheme } from '@/ui';

import { emergencyCopy } from './copy';
import { useEmergencyCard } from './useEmergencyContacts';

const copy = emergencyCopy.card;

/** The card itself: the phone glyph in its disc, the title and line, Not now at the right. */
export function EmergencyCardView({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  const t = useTheme();
  return (
    <Card onPress={onOpen} accessibilityLabel={`${copy.title}. ${copy.body}`} accessibilityHint={copy.hint} testID="home-emergency">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accentFaint }}>
          <Ionicons name="call" size={t.size.iconLg} color={t.colors.accent} accessible={false} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="headline">{copy.title}</Text>
          <Text variant="subhead" tone="muted">
            {copy.body}
          </Text>
        </View>
        <IconButton icon="close" accessibilityLabel={copy.dismiss} onPress={onDismiss} variant="plain" testID="home-emergency-dismiss" />
      </View>
    </Card>
  );
}

/**
 * Home's "Add emergency contacts" card, the last action item: shown until a contact is saved or
 * the card is closed with its ✕ (for good), and never while a drive records. A tap opens
 * Settings › Emergency contacts.
 */
export function HomeEmergencyCard({ hidden }: { hidden: boolean }) {
  const router = useRouter();
  const { show, dismiss, refetch } = useEmergencyCard();
  // Gone at once on Not now, whatever a read already on its way says when it lands.
  const [gone, setGone] = useState(false);
  // A contact saved a screen deeper takes the card down on the way back.
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch])
  );
  if (hidden || gone || !show) return null;
  return (
    <EmergencyCardView
      onOpen={() => router.push(SETTINGS_HREFS.emergency)}
      onDismiss={() => {
        setGone(true);
        dismiss();
      }}
    />
  );
}

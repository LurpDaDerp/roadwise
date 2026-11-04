// Home's "Where you parked" (iPhone with the car link): the spot the drive host stored when the
// paired car went off with the car stopped and the driver walked away (`src/drive/parkedWatch.ts`).
// The drive's end label and the time, "Walk back" (walking directions in the driver's navigation
// app, or Apple Maps), and the ✕ top right. Gone on ✕, once a later drive is kept, and after 3
// days. Never during a drive; never on Android.
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, View } from 'react-native';

import { useDataSource } from '@/data/queries/context';
import { useDrive } from '@/drive/useDrive';
import { formatWhen } from '@/features/drives/format';
import { openWalkingDirections } from '@/features/navigation/apps';
import { readNavApp } from '@/features/navigation/prefs';
import { Button, Card, IconButton, Text, useTheme } from '@/ui';

import { parkedCopy as copy } from './copy';
import { clearParkedSpot, keptDriveSince, onParkedChanged, parkedExpired, readParkedSpot, type ParkedSpot } from './model';

function ParkedDisc() {
  const t = useTheme();
  return (
    <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accentFaint }}>
      <Ionicons name="car" size={t.size.iconLg} color={t.colors.accent} accessible={false} />
    </View>
  );
}

/** The card itself. */
export function ParkedCardView({ spot, onWalk, onDismiss }: { spot: ParkedSpot; onWalk: () => void; onDismiss: () => void }) {
  const t = useTheme();
  return (
    <Card testID="home-parked">
      <View style={{ gap: t.space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
          <ParkedDisc />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="headline">{copy.title}</Text>
            <Text variant="subhead" tone="muted" testID="home-parked-line">
              {copy.line(spot.label, formatWhen(spot.parkedAt))}
            </Text>
          </View>
          <IconButton icon="close" accessibilityLabel={copy.dismiss} onPress={onDismiss} variant="plain" style={{ alignSelf: 'flex-start' }} testID="home-parked-dismiss" />
        </View>
        <View style={{ flexDirection: 'row' }}>
          <Button label={copy.walk} size="sm" onPress={onWalk} accessibilityHint={copy.walkHint} testID="home-parked-walk" />
        </View>
      </View>
    </Card>
  );
}

/** Home's slot: the stored spot while it holds, else nothing. Read on focus, at a drive's end and whenever the host stores or clears one. */
export function HomeParkedCard({ hidden }: { hidden: boolean }) {
  const { db, now } = useDataSource();
  const lastFinalized = useDrive((d) => d.lastFinalized);
  const [spot, setSpot] = useState<ParkedSpot | null>(null);
  const ios = Platform.OS === 'ios';

  const reload = useCallback(() => {
    if (!ios) return () => {};
    let live = true;
    void (async () => {
      const s = await readParkedSpot(db);
      if (s !== null && (parkedExpired(s, now()) || (await keptDriveSince(db, s)))) {
        // Too old, or the car has moved since: it goes for good.
        await clearParkedSpot(db);
        return;
      }
      if (live) setSpot(s);
    })().catch(() => {
      if (live) setSpot(null);
    });
    return () => {
      live = false;
    };
  }, [db, now, ios]);
  useFocusEffect(reload);
  useEffect(() => reload(), [reload, lastFinalized]);
  useEffect(() => onParkedChanged(() => void reload()), [reload]);

  if (!ios || hidden || spot === null) return null;
  return (
    <ParkedCardView
      spot={spot}
      onWalk={() => {
        void (async () => {
          await openWalkingDirections(await readNavApp(db), { lat: spot.lat, lng: spot.lng });
        })().catch(() => {});
      }}
      onDismiss={() => {
        setSpot(null);
        void clearParkedSpot(db).catch(() => {});
      }}
    />
  );
}

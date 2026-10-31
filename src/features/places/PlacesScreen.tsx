import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { readZones } from '@/features/settings/privacyZones';
import { LinkRow, RowIcon, Section, TopBar } from '@/features/settings/parts';
import { SETTINGS_HREFS } from '@/features/settings/routes';
import { Button, ListRow, Screen, Text, useTheme } from '@/ui';

import { placesCopy } from './copy';
import { FIXED_KINDS, FIXED_NAME, MAX_CUSTOM_PLACES, type SavedPlace } from './model';
import { placeIcon, PlaceSheet, type PlaceSheetDeps, type PlaceTarget } from './PlaceSheet';
import { usePlaces } from './usePlaces';

const copy = placesCopy;

/** A saved place's row: its name, and its address (or "Add address" while it has none). */
function PlaceRow({ title, place, icon, onPress, testID }: { title: string; place: SavedPlace | undefined; icon: Parameters<typeof RowIcon>[0]['name']; onPress: () => void; testID: string }) {
  const line = place ? [place.address, place.area].filter((s) => s !== '').join(', ') : copy.noAddress;
  return (
    <ListRow
      title={title}
      subtitle={line}
      leading={<RowIcon name={icon} />}
      accessibilityLabel={place ? `${title}, ${line}` : `${title}, ${copy.noAddress}`}
      onPress={onPress}
      testID={testID}
    />
  );
}

/**
 * `/settings/places`: Home, Work and School (each an address, or "Add address"), then your own
 * places and Add a place (up to 7), then the way to hide them in Privacy zones. A tap opens the
 * place's sheet (`PlaceSheet`): a search for a new one, the place on a map for a saved one.
 * Everything stays on this phone.
 */
export function PlacesScreen({ deps = {} }: { deps?: PlaceSheetDeps }) {
  const th = useTheme();
  const router = useRouter();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const { places, save, remove } = usePlaces();
  const [target, setTarget] = useState<PlaceTarget | null>(null);
  const [hidden, setHidden] = useState(0);

  // How many places are hidden, read on every focus so a zone turned on a screen deeper shows on the way back.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      void readZones(settings)
        .then((z) => {
          if (live) setHidden(z.filter((zone) => zone.placeId !== undefined && (places ?? []).some((p) => p.id === zone.placeId)).length);
        })
        .catch(() => {});
      return () => {
        live = false;
      };
    }, [settings, places])
  );

  const list = places ?? [];
  const custom = list.filter((p) => p.kind === 'custom');
  const full = custom.length >= MAX_CUSTOM_PLACES;

  return (
    <Screen scroll testID="places-screen">
      <TopBar title={copy.title} />
      <Text variant="body">{copy.intro}</Text>

      <Section title={copy.fixedTitle} testID="places-fixed">
        {FIXED_KINDS.map((kind) => {
          const place = list.find((p) => p.kind === kind);
          return <PlaceRow key={kind} title={FIXED_NAME[kind]} place={place} icon={placeIcon(kind)} onPress={() => setTarget({ kind, place: place ?? null })} testID={`places-${kind}`} />;
        })}
      </Section>

      {custom.length > 0 ? (
        <Section title={copy.otherTitle} footer={full ? copy.max : undefined} testID="places-custom">
          {custom.map((p) => (
            <PlaceRow key={p.id} title={p.name} place={p} icon={placeIcon('custom')} onPress={() => setTarget({ kind: 'custom', place: p })} testID={`places-${p.id}`} />
          ))}
        </Section>
      ) : null}

      <Button label={copy.add} icon="add" variant="secondary" onPress={() => setTarget({ kind: 'custom', place: null })} disabled={places === undefined || full} testID="places-add" />

      <Section>
        <LinkRow icon="eye-off-outline" title={copy.zonesRow.title} subtitle={copy.zonesRow.subtitle(hidden)} onPress={() => router.push(SETTINGS_HREFS.privacyZones)} testID="places-zones" />
      </Section>

      <View style={{ gap: th.space.sm }}>
        <Text variant="footnote" tone="muted">
          {copy.local}
        </Text>
        <Text variant="footnote" tone="muted">
          {copy.searchNote}
        </Text>
      </View>

      <PlaceSheet target={target} places={list} onClose={() => setTarget(null)} onSave={save} onRemove={(p) => remove(p.id)} deps={deps} />
    </Screen>
  );
}

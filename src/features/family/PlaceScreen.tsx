import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';

import { TripTopBar } from '@/features/trips/TopBar';
import { Banner, Button, Screen, Skeleton, Text, useTheme } from '@/ui';

import type { FamilyPlace } from './api';
import { familyCopy as copy } from './copy';
import { errorText, FamilyTextField, FieldLabel } from './parts';
import { useFamily, useFamilyActions, type FamilyDeps } from './useFamily';

const FAMILY_TAB = '/(tabs)/family' as Href;
export const PLACE_RADII = [100, 150, 300, 500] as const;

/** Finds an address on the phone (expo-location's geocoder); null when nothing was found. */
export type Geocode = (address: string) => Promise<{ lat: number; lng: number } | null>;

async function expoGeocode(address: string): Promise<{ lat: number; lng: number } | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a native module, only when used
  const Location = require('expo-location') as typeof import('expo-location');
  const found = await Location.geocodeAsync(address);
  const first = found[0];
  return first ? { lat: first.latitude, lng: first.longitude } : null;
}

export interface PlaceDeps extends FamilyDeps {
  geocode?: Geocode;
  alert?: typeof Alert.alert;
}

/**
 * Add or edit a family place: a name, an address found on the phone, and how close counts as "at"
 * it. Places are the whole family's: anyone in it can add, edit or delete one. No alerts are sent
 * when someone arrives or leaves; the list simply reads "At Home".
 */
export function PlaceScreen({ id, deps = {} }: { id?: string; deps?: PlaceDeps }) {
  const family = useFamily(deps);
  // An edit waits for the snapshot, so the form starts from the place rather than filling in late.
  if (id !== undefined && family.data === undefined) {
    return (
      <Screen testID="family-place-screen">
        <Skeleton width="100%" height={200} />
      </Screen>
    );
  }
  const existing: FamilyPlace | null = id === undefined ? null : (family.data?.family?.places.find((p) => p.id === id) ?? null);
  return <PlaceForm key={existing?.id ?? 'new'} existing={existing} deps={deps} />;
}

function PlaceForm({ existing, deps }: { existing: FamilyPlace | null; deps: PlaceDeps }) {
  const th = useTheme();
  const router = useRouter();
  const actions = useFamilyActions(deps);
  const [name, setName] = useState(existing?.name ?? '');
  const [address, setAddress] = useState(existing?.address ?? '');
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(existing ? { lat: existing.lat, lng: existing.lng } : null);
  const [radius, setRadius] = useState<number>(existing?.radiusM ?? 150);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leave = () => (router.canGoBack() ? router.back() : router.replace(FAMILY_TAB));
  const alert = deps.alert ?? Alert.alert;

  const find = async () => {
    setError(null);
    setFinding(true);
    try {
      const found = await (deps.geocode ?? expoGeocode)(address.trim());
      if (found === null) setError(copy.place.notFound);
      setPoint(found);
    } catch {
      setError(copy.place.notFound);
      setPoint(null);
    } finally {
      setFinding(false);
    }
  };

  const save = () => {
    if (point === null) {
      setError(copy.place.needAddress);
      return;
    }
    setError(null);
    actions.savePlace.mutate(
      { id: existing?.id, name: name.trim(), address: address.trim(), lat: point.lat, lng: point.lng, radiusM: radius },
      { onSuccess: leave, onError: (e) => setError(errorText(e)) }
    );
  };

  const remove = () => {
    if (existing === null) return;
    alert(copy.place.deleteTitle, copy.place.deleteBody, [
      { text: copy.place.cancel, style: 'cancel' },
      {
        text: copy.place.deleteConfirm,
        style: 'destructive',
        onPress: () => actions.deletePlace.mutate(existing.id, { onSuccess: leave, onError: (e) => setError(errorText(e)) }),
      },
    ]);
  };

  return (
    <Screen scroll testID="family-place-screen">
      <TripTopBar title={existing ? copy.place.editTitle : copy.place.addTitle} onBack={leave} />
      <View style={{ gap: th.space.lg }}>
        {error ? <Banner tone="danger" message={error} testID="family-place-error" /> : null}
        <FamilyTextField
          testID="family-place-name"
          label={copy.place.nameLabel}
          placeholder={copy.place.namePlaceholder}
          value={name}
          onChangeText={setName}
          maxLength={40}
          autoCapitalize="words"
        />
        <View style={{ gap: th.space.sm }}>
          <FamilyTextField
            testID="family-place-address"
            label={copy.place.addressLabel}
            placeholder={copy.place.addressPlaceholder}
            value={address}
            onChangeText={(t) => {
              setAddress(t);
              setPoint(null);
            }}
            maxLength={200}
            autoComplete="street-address"
            textContentType="fullStreetAddress"
            returnKeyType="search"
            onSubmitEditing={() => address.trim() !== '' && void find()}
          />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.md }}>
            <Button
              label={finding ? copy.place.finding : copy.place.find}
              variant="secondary"
              size="md"
              disabled={address.trim() === '' || finding}
              onPress={() => void find()}
              testID="family-place-find"
            />
            {point !== null ? (
              <Text variant="footnote" tone="muted" testID="family-place-found" style={{ flex: 1 }}>
                {copy.place.found(point.lat, point.lng)}
              </Text>
            ) : null}
          </View>
        </View>
        <View style={{ gap: th.space.sm }}>
          <FieldLabel>{copy.place.radiusLabel}</FieldLabel>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.sm }} accessibilityRole="radiogroup">
            {PLACE_RADII.map((r) => {
              const selected = r === radius;
              return (
                <Pressable
                  key={r}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={copy.place.radius(r)}
                  onPress={() => setRadius(r)}
                  testID={`family-place-radius-${r}`}
                  style={{
                    minHeight: 44,
                    paddingHorizontal: th.space.lg,
                    justifyContent: 'center',
                    borderRadius: th.radius.pill,
                    borderWidth: 1.5,
                    borderColor: selected ? th.colors.accent : th.colors.borderStrong,
                    backgroundColor: selected ? th.colors.accentFaint : th.colors.surface,
                  }}
                >
                  <Text variant="subhead" tone={selected ? 'accent' : 'default'}>
                    {copy.place.radius(r)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        <Button
          label={copy.place.save}
          onPress={save}
          disabled={name.trim() === '' || point === null || actions.savePlace.isPending}
          loading={actions.savePlace.isPending}
          testID="family-place-save"
        />
        {existing !== null ? (
          <Button label={copy.place.delete} variant="destructive" onPress={remove} testID="family-place-delete" />
        ) : null}
      </View>
    </Screen>
  );
}

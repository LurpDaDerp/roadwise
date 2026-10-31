import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, Switch, TextInput, View } from 'react-native';

import { createPermissionsAdapter } from '@/core/permissions';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import type { SavedPlace } from '@/features/places/model';
import { usePlaces } from '@/features/places/usePlaces';
import { requestSpotRecompute } from '@/features/spots/recompute';
import { Banner, Button, Chip, EmptyState, IconButton, ListRow, Screen, Sheet, Text, useFontScale, useTheme, withAlpha } from '@/ui';

import { settingsCopy } from './copy';
import { loadMaps, US_REGION } from './maps';
import { LinkRow, RowIcon, Section, TopBar } from './parts';
import { SETTINGS_HREFS } from './routes';
import {
  DEFAULT_RADIUS_M,
  MAX_RADIUS_M,
  MAX_ZONES,
  MIN_RADIUS_M,
  newZoneId,
  readZones,
  stepRadius,
  writeZones,
  ZONE_NAME_MAX,
  zoneProblem,
  type PrivacyZone,
  type ZoneProblem,
} from './privacyZones';

const copy = settingsCopy.zones;
const placeCopy = copy.places;

export type LocateResult = { ok: true; lat: number; lng: number } | { ok: false; reason: 'denied' | 'failed' };

/**
 * One fix from the phone. While Using location is asked for through the one permission adapter
 * (the OS shows a prompt only while it still can).
 */
export async function locateOnce(): Promise<LocateResult> {
  try {
    const access = await createPermissionsAdapter().requestLocationForeground();
    if (access !== 'foreground' && access !== 'always') return { ok: false, reason: 'denied' };
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
    const Location = require('expo-location') as typeof import('expo-location');
    const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { ok: true, lat: fix.coords.latitude, lng: fix.coords.longitude };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

interface Draft {
  id: string | null;
  name: string;
  lat: number | null;
  lng: number | null;
  radiusM: number;
  /** A saved place's zone: its name and centre are the place's, only its size is edited here. */
  placeId?: string;
  /** That place's address, for the editor's line. */
  address?: string;
}

const placeIcons: Record<SavedPlace['kind'], keyof typeof Ionicons.glyphMap> = {
  home: 'home-outline',
  work: 'briefcase-outline',
  school: 'school-outline',
  custom: 'location-outline',
};

const EMPTY_DRAFT: Draft = { id: null, name: '', lat: null, lng: null, radiusM: DEFAULT_RADIUS_M };

function draftProblem(d: Draft): ZoneProblem | null {
  return zoneProblem({ name: d.name, lat: d.lat ?? NaN, lng: d.lng ?? NaN, radiusM: d.radiusM });
}

export interface PrivacyZonesDeps {
  locate?: () => Promise<LocateResult>;
}

/**
 * `/settings/privacy-zones`: up to 6 places whose surroundings never show on a map. First the
 * driver's saved places (Settings › Places), each with a switch that hides it under a 300 m zone
 * centred on it (a tap on a hidden one sets its size), or a row to add places when there are none.
 * Then the other zones, each a name, a centre (current location, or a tap on the map) and a
 * 200–800 m radius set with a stepper. Everything stays on this phone.
 */
export function PrivacyZonesScreen({ deps = {} }: { deps?: PrivacyZonesDeps }) {
  const th = useTheme();
  const router = useRouter();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const { places } = usePlaces();
  const [zones, setZones] = useState<PrivacyZone[] | null>(null);
  const [fullNote, setFullNote] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<ZoneProblem | null>(null);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    let live = true;
    void readZones(settings)
      .catch(() => [])
      .then((z) => {
        if (live) setZones(z);
      });
    return () => {
      live = false;
    };
  }, [settings]);

  const persist = async (next: PrivacyZone[]): Promise<boolean> => {
    setSaveError(false);
    try {
      await writeZones(settings, next);
      setZones(next);
      // A spot inside a zone gives up its rank to the next one.
      requestSpotRecompute();
      return true;
    } catch {
      setSaveError(true);
      return false;
    }
  };

  const onSave = async () => {
    if (!draft || !zones) return;
    const p = draftProblem(draft);
    const adding = draft.id === null;
    if (p || (adding && zones.length >= MAX_ZONES)) {
      setProblem(p ?? 'too_many');
      return;
    }
    const zone: PrivacyZone = {
      id: draft.id ?? newZoneId(),
      name: draft.name.trim(),
      lat: draft.lat as number,
      lng: draft.lng as number,
      radiusM: draft.radiusM,
      ...(draft.placeId ? { placeId: draft.placeId } : {}),
    };
    const next = adding ? [...zones, zone] : zones.map((z) => (z.id === zone.id ? zone : z));
    if (await persist(next)) setDraft(null);
  };

  const onRemove = (zone: PrivacyZone) => {
    Alert.alert(copy.removeTitle(zone.name), copy.removeBody, [
      { text: copy.cancel, style: 'cancel' },
      {
        text: copy.remove,
        style: 'destructive',
        onPress: () => {
          void persist((zones ?? []).filter((z) => z.id !== zone.id)).then((ok) => {
            if (ok) setDraft(null);
          });
        },
      },
    ]);
  };

  const open = (d: Draft) => {
    setProblem(null);
    setDraft(d);
  };

  const full = (zones?.length ?? 0) >= MAX_ZONES;
  const saved = places ?? [];
  const placeZone = (p: SavedPlace) => zones?.find((z) => z.placeId === p.id);
  // A zone whose place was removed is an ordinary zone again.
  const others = (zones ?? []).filter((z) => z.placeId === undefined || !saved.some((p) => p.id === z.placeId));

  /** Hide a place under a zone of its own, centred on it. */
  const hidePlace = (p: SavedPlace) => {
    if (!zones) return;
    if (full) {
      setFullNote(true);
      return;
    }
    setFullNote(false);
    const zone: PrivacyZone = { id: newZoneId(), name: p.name.slice(0, ZONE_NAME_MAX), lat: p.lat, lng: p.lng, radiusM: DEFAULT_RADIUS_M, placeId: p.id };
    void persist([...zones, zone]);
  };

  /** Show a place on maps again: its zone goes, after a check. */
  const showPlace = (p: SavedPlace) => {
    Alert.alert(placeCopy.stopTitle(p.name), copy.removeBody, [
      { text: copy.cancel, style: 'cancel' },
      {
        text: placeCopy.stop,
        style: 'destructive',
        onPress: () => {
          void persist((zones ?? []).filter((z) => z.placeId !== p.id)).then((ok) => {
            if (ok) setDraft(null);
          });
        },
      },
    ]);
  };

  const editPlaceZone = (p: SavedPlace, z: PrivacyZone) =>
    open({ id: z.id, name: z.name, lat: p.lat, lng: p.lng, radiusM: z.radiusM, placeId: p.id, address: [p.address, p.area].filter((s) => s !== '').join(', ') });

  return (
    <Screen scroll testID="privacy-zones-screen">
      <TopBar title={copy.title} />
      <Text variant="body">{copy.intro}</Text>
      {saveError ? <Banner tone="danger" message={copy.saveError} testID="zones-save-error" /> : null}

      {places && zones ? (
        saved.length > 0 ? (
          <Section title={placeCopy.title} footer={fullNote ? placeCopy.full : placeCopy.footer} testID="zones-places">
            {saved.map((p) => {
              const z = placeZone(p);
              return (
                <PlaceZoneRow
                  key={p.id}
                  place={p}
                  zone={z}
                  onToggle={(on) => (on ? hidePlace(p) : showPlace(p))}
                  onPress={() => (z ? editPlaceZone(p, z) : hidePlace(p))}
                />
              );
            })}
          </Section>
        ) : (
          <Section>
            <LinkRow icon="home-outline" title={placeCopy.add.title} subtitle={placeCopy.add.subtitle} onPress={() => router.push(SETTINGS_HREFS.places)} testID="zones-add-places" />
          </Section>
        )
      ) : null}

      {zones && others.length > 0 ? (
        <Section title={saved.length > 0 ? placeCopy.others : undefined} footer={full ? copy.max : undefined} testID="zones-list">
          {others.map((z) => (
            <ListRow
              key={z.id}
              testID={`zone-${z.id}`}
              title={z.name}
              subtitle={copy.radius(z.radiusM)}
              leading={<RowIcon name="eye-off-outline" />}
              accessibilityHint={copy.editTitle}
              onPress={() => open({ id: z.id, name: z.name, lat: z.lat, lng: z.lng, radiusM: z.radiusM })}
            />
          ))}
        </Section>
      ) : zones && saved.length === 0 ? (
        <EmptyState icon="eye-off-outline" title={copy.empty} body={copy.emptyBody} testID="zones-empty" />
      ) : null}

      <Button label={copy.add} icon="add" onPress={() => open(EMPTY_DRAFT)} disabled={zones === null || full} testID="zones-add" />

      <View style={{ gap: th.space.sm }}>
        <InfoLine icon="phone-portrait-outline" text={copy.local} />
        <InfoLine icon="cut-outline" text={copy.trim} />
      </View>

      <Sheet
        visible={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.placeId ? placeCopy.editTitle(draft.name) : draft?.id ? copy.editTitle : copy.newTitle}
        scroll
        testID="zone-editor"
      >
        {draft ? (
          <ZoneEditor
            draft={draft}
            onChange={(d) => {
              setProblem(null);
              setDraft(d);
            }}
            onCenter={(lat, lng) => {
              setProblem(null);
              // The draft as it is when the fix lands: what was typed meanwhile stays, and a closed editor stays closed.
              setDraft((cur) => (cur === null ? null : { ...cur, lat, lng }));
            }}
            problem={problem}
            locate={deps.locate ?? locateOnce}
            onSave={() => void onSave()}
            onRemove={(() => {
              const linked = draft.placeId ? saved.find((p) => p.id === draft.placeId) : undefined;
              if (linked) return () => showPlace(linked);
              return draft.id ? () => onRemove(zones?.find((z) => z.id === draft.id) ?? (draft as PrivacyZone)) : undefined;
            })()}
          />
        ) : null}
      </Sheet>
    </Screen>
  );
}

/** A saved place in Privacy zones: its name, whether it's hidden (and how wide), and the switch that hides it. */
function PlaceZoneRow({ place, zone, onToggle, onPress }: { place: SavedPlace; zone: PrivacyZone | undefined; onToggle: (on: boolean) => void; onPress: () => void }) {
  const th = useTheme();
  const line = zone ? placeCopy.hidden(zone.radiusM) : placeCopy.shown;
  return (
    <Pressable
      accessible={false}
      onPress={onPress}
      testID={`zones-place-${place.id}`}
      style={({ pressed }) => ({
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space.md,
        paddingVertical: th.space.md,
        paddingHorizontal: th.space.lg,
        backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
      })}
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <RowIcon name={zone ? 'eye-off-outline' : placeIcons[place.kind]} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body">{place.name}</Text>
        <Text variant="footnote" tone="muted">
          {line}
        </Text>
      </View>
      <Switch
        testID={`zones-place-${place.id}-switch`}
        accessibilityLabel={placeCopy.hideLabel(place.name)}
        accessibilityHint={line}
        value={zone !== undefined}
        onValueChange={onToggle}
        trackColor={{ true: th.colors.accent, false: th.colors.border }}
        ios_backgroundColor={th.colors.border}
        thumbColor="#FFFFFF"
      />
    </Pressable>
  );
}

function InfoLine({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  const th = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: th.space.sm, alignItems: 'flex-start' }}>
      <Ionicons name={icon} size={th.size.icon} color={th.colors.textMuted} accessibilityElementsHidden importantForAccessibility="no" />
      <Text variant="footnote" tone="muted" style={{ flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}

function ZoneEditor({
  draft,
  onChange,
  onCenter,
  problem,
  locate,
  onSave,
  onRemove,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  /** A centre that arrives later (the location fix): applied to the draft as it is by then. */
  onCenter: (lat: number, lng: number) => void;
  problem: ZoneProblem | null;
  locate: () => Promise<LocateResult>;
  onSave: () => void;
  onRemove?: () => void;
}) {
  const th = useTheme();
  const scale = useFontScale();
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<'denied' | 'failed' | null>(null);
  const maps = loadMaps();
  const hasCenter = draft.lat !== null && draft.lng !== null;
  // A saved place's zone: named and centred by the place, so only its size is set here.
  const linked = draft.placeId !== undefined;
  // A fix that lands after this editor closed belongs to no draft (a reopened editor is a new one).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const locateHere = async () => {
    setLocating(true);
    setLocateError(null);
    const r = await locate();
    if (!mounted.current) return;
    setLocating(false);
    if (r.ok) onCenter(r.lat, r.lng);
    else setLocateError(r.reason);
  };

  return (
    <View style={{ gap: th.space.lg, paddingBottom: th.space.lg }}>
      {linked ? (
        <Text variant="body" tone="muted" testID="zone-place-center">
          {placeCopy.centered(draft.address || draft.name)}
        </Text>
      ) : (
      <View style={{ gap: th.space.sm }}>
        <Text variant="headline">{copy.name}</Text>
        <TextInput
          testID="zone-name"
          accessibilityLabel={copy.name}
          value={draft.name}
          onChangeText={(name) => onChange({ ...draft, name })}
          placeholder={copy.namePlaceholder}
          placeholderTextColor={th.colors.textSubtle}
          maxLength={ZONE_NAME_MAX}
          allowFontScaling={false}
          autoCorrect={false}
          style={{
            minHeight: 48 * scale,
            borderWidth: 1.5,
            borderColor: th.colors.borderStrong,
            borderRadius: th.radius.md,
            paddingHorizontal: th.space.md,
            backgroundColor: th.colors.surface,
            color: th.colors.text,
            fontSize: 17 * scale,
          }}
        />
        <View style={{ flexDirection: 'row', gap: th.space.sm }}>
          {copy.presets.map((p) => (
            <Chip key={p} label={p} selected={draft.name.trim() === p} onPress={() => onChange({ ...draft, name: p })} testID={`zone-preset-${p}`} />
          ))}
        </View>
      </View>
      )}

      <View style={{ gap: th.space.sm }}>
        <Text variant="headline">{copy.size}</Text>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={copy.size}
          accessibilityValue={{ min: MIN_RADIUS_M, max: MAX_RADIUS_M, now: draft.radiusM, text: copy.radius(draft.radiusM) }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) =>
            onChange({ ...draft, radiusM: stepRadius(draft.radiusM, e.nativeEvent.actionName === 'increment' ? 1 : -1) })
          }
          style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.md }}
        >
          <IconButton
            icon="remove"
            variant="tinted"
            accessibilityLabel={copy.smaller}
            disabled={draft.radiusM <= MIN_RADIUS_M}
            onPress={() => onChange({ ...draft, radiusM: stepRadius(draft.radiusM, -1) })}
            testID="zone-smaller"
          />
          <Text variant="stat" style={{ flex: 1, textAlign: 'center' }} testID="zone-radius">
            {`${draft.radiusM} m`}
          </Text>
          <IconButton
            icon="add"
            variant="tinted"
            accessibilityLabel={copy.bigger}
            disabled={draft.radiusM >= MAX_RADIUS_M}
            onPress={() => onChange({ ...draft, radiusM: stepRadius(draft.radiusM, 1) })}
            testID="zone-bigger"
          />
        </View>
      </View>

      <View style={{ gap: th.space.sm }}>
        {linked ? null : (
          <>
            <Text variant="headline">{copy.center}</Text>
            <Button
              label={locating ? copy.locating : copy.useLocation}
              icon="locate"
              variant="secondary"
              size="md"
              loading={locating}
              onPress={() => void locateHere()}
              testID="zone-use-location"
            />
          </>
        )}
        {locateError ? (
          <Text variant="footnote" tone="danger" accessibilityRole="alert">
            {locateError === 'denied' ? copy.locationDenied : copy.locationFailed}
          </Text>
        ) : null}
        {maps ? (
          <>
            {linked ? null : (
              <Text variant="footnote" tone="muted">
                {copy.pickOnMap}
              </Text>
            )}
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={{ height: 220, borderRadius: th.radius.lg, overflow: 'hidden', borderCurve: 'continuous' }}
            >
              <maps.default
                style={{ flex: 1 }}
                initialRegion={
                  hasCenter
                    ? { latitude: draft.lat as number, longitude: draft.lng as number, latitudeDelta: 0.03, longitudeDelta: 0.03 }
                    : US_REGION
                }
                region={
                  hasCenter
                    ? { latitude: draft.lat as number, longitude: draft.lng as number, latitudeDelta: 0.03, longitudeDelta: 0.03 }
                    : undefined
                }
                onPress={linked ? undefined : (e) => onChange({ ...draft, lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude })}
                showsPointsOfInterests={false}
                toolbarEnabled={false}
              >
                {hasCenter ? (
                  <maps.Circle
                    center={{ latitude: draft.lat as number, longitude: draft.lng as number }}
                    radius={draft.radiusM}
                    strokeColor={th.colors.accent}
                    fillColor={withAlpha(th.colors.accent, th.scheme === 'dark' ? 0.22 : 0.16)}
                    strokeWidth={2}
                  />
                ) : null}
              </maps.default>
            </View>
          </>
        ) : null}
        {linked ? null : (
          <Text variant="footnote" tone={hasCenter ? 'success' : 'muted'} testID="zone-center-status">
            {hasCenter ? copy.centerSet : copy.noCenter}
          </Text>
        )}
      </View>

      {problem ? (
        <Text variant="callout" tone="danger" accessibilityRole="alert" testID="zone-problem">
          {copy.problems[problem]}
        </Text>
      ) : null}

      <Button label={linked ? placeCopy.saveSize : copy.save} onPress={onSave} testID="zone-save" />
      {onRemove ? <Button label={linked ? placeCopy.stop : copy.remove} variant="destructive" size="md" onPress={onRemove} testID="zone-remove" /> : null}
    </View>
  );
}

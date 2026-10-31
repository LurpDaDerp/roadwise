import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Keyboard, Pressable, TextInput, View } from 'react-native';

import type { PlaceSlot } from '@/core/places/learn';
import { locateOnce, type LocateResult } from '@/features/settings/PrivacyZonesScreen';
import { loadMaps } from '@/features/settings/maps';
import { RowIcon, Section } from '@/features/settings/parts';
import type { LatLng } from '@/lib/geo';
import { Button, ListRow, Sheet, Text, useFontScale, useTheme } from '@/ui';

import { placesCopy } from './copy';
import { useLearnedPlaces, useSuggestions, type Suggestion } from './learned';
import { FIXED_NAME, idFor, PLACE_NAME_MAX, placeProblem, type PlaceKind, type PlaceProblem, type SavedPlace } from './model';
import { addressAt, lookUpExact, MIN_QUERY, searchAddresses, searchBias, SEARCH_DEBOUNCE_MS, type AddressHit, type SearchResult } from './search';

const copy = placesCopy.sheet;

/** What the sheet edits: a kind of place, and the saved one when there is one. */
export interface PlaceTarget {
  kind: PlaceKind;
  place: SavedPlace | null;
}

export interface PlaceSheetDeps {
  search?: (q: string, near: LatLng | null, opts: { signal?: AbortSignal }) => Promise<SearchResult>;
  exact?: (q: string) => Promise<AddressHit | null>;
  addressAt?: (p: LatLng) => Promise<{ title: string; subtitle: string } | null>;
  locate?: () => Promise<LocateResult>;
  bias?: () => Promise<LatLng | null>;
}

interface Chosen {
  title: string;
  subtitle: string;
  lat: number;
  lng: number;
}

type SearchState = { state: 'idle' | 'loading' | 'done' | 'failed'; hits: AddressHit[] };

const icons: Record<PlaceKind, keyof typeof Ionicons.glyphMap> = {
  home: 'home-outline',
  work: 'briefcase-outline',
  school: 'school-outline',
  custom: 'location-outline',
};
export const placeIcon = (kind: PlaceKind) => icons[kind];

const isAddressLike = (s: string) => /^\d/.test(s.trim());

/**
 * One place's sheet. A new place opens on the search: the field (focused), "Use my current
 * location", the places learned from your drives that fit this field, then, from 3 characters,
 * those learned places whose address matches and Photon's addresses, and last "Look up …" through
 * the phone's own geocoder. Picking one shows it on a map (tap to move the pin) with Save; one of
 * your own places also takes a name. A saved place opens on that view, with Change address and
 * Remove.
 */
export function PlaceSheet({
  target,
  places,
  onClose,
  onSave,
  onRemove,
  deps = {},
}: {
  target: PlaceTarget | null;
  places: readonly SavedPlace[];
  onClose: () => void;
  onSave: (place: SavedPlace) => Promise<boolean>;
  onRemove: (place: SavedPlace) => Promise<boolean>;
  deps?: PlaceSheetDeps;
}) {
  const visible = target !== null;
  const title = target ? (target.place?.name ?? (target.kind === 'custom' ? copy.newTitle : FIXED_NAME[target.kind])) : '';
  return (
    <Sheet visible={visible} onClose={onClose} title={title} scroll testID="place-sheet">
      {target ? (
        <PlaceEditor key={`${target.kind}:${target.place?.id ?? 'new'}`} target={target} places={places} onClose={onClose} onSave={onSave} onRemove={onRemove} deps={deps} />
      ) : null}
    </Sheet>
  );
}

function PlaceEditor({
  target,
  places,
  onClose,
  onSave,
  onRemove,
  deps,
}: {
  target: PlaceTarget;
  places: readonly SavedPlace[];
  onClose: () => void;
  onSave: (place: SavedPlace) => Promise<boolean>;
  onRemove: (place: SavedPlace) => Promise<boolean>;
  deps: PlaceSheetDeps;
}) {
  const th = useTheme();
  const scale = useFontScale();
  const { kind, place } = target;
  const search = deps.search ?? searchAddresses;
  const exact = deps.exact ?? lookUpExact;
  const reverse = deps.addressAt ?? addressAt;
  const locate = deps.locate ?? locateOnce;

  const [mode, setMode] = useState<'search' | 'confirm'>(place ? 'confirm' : 'search');
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<{ q: string; ok: boolean; hits: AddressHit[] } | null>(null);
  const [chosen, setChosen] = useState<Chosen | null>(place ? { title: place.address, subtitle: place.area, lat: place.lat, lng: place.lng } : null);
  const [name, setName] = useState(place?.kind === 'custom' ? place.name : '');
  const [problem, setProblem] = useState<PlaceProblem | null>(null);
  const [busy, setBusy] = useState<null | 'locate' | 'exact' | 'pick' | 'save'>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [bias, setBias] = useState<LatLng | null>(null);

  // Live while open: a lookup that lands after the sheet closed is dropped.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // The places already saved (but this one) aren't offered again.
  const taken = useMemo(() => places.filter((p) => p.id !== place?.id).map((p) => ({ lat: p.lat, lng: p.lng })), [places, place]);
  const slot: PlaceSlot = kind;
  const suggestions = useSuggestions(slot, taken, mode === 'search');
  const learned = useLearnedPlaces(mode === 'search');

  // Nearby addresses first: the phone's last known position, else the place you drive to most (both rounded to ~10 km).
  const biasFrom = deps.bias ?? searchBias;
  const fallbackBias = learned.data?.[0]?.center ?? null;
  useEffect(() => {
    let alive = true;
    void biasFrom().then((p) => {
      if (alive && p) setBias(p);
    });
    return () => {
      alive = false;
    };
  }, [biasFrom]);
  const near = bias ?? fallbackBias;

  const q = query.trim();
  const searching = mode === 'search' && q.length >= MIN_QUERY;
  useEffect(() => {
    if (!searching) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      void search(q, near, { signal: ctrl.signal }).then((r) => {
        if (ctrl.signal.aborted || !live.current) return;
        setAnswer({ q, ok: r.ok, hits: r.ok ? r.hits : [] });
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // `near` is read when a search goes; a better bias arriving later doesn't search again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, searching, search]);
  // The answer to what's typed now; while a newer one is on its way the last hits stay up.
  const answered = answer !== null && answer.q === q;
  const found: SearchState = !searching
    ? { state: 'idle', hits: [] }
    : { state: answered ? (answer.ok ? 'done' : 'failed') : 'loading', hits: answer?.hits ?? [] };

  const choose = (c: Chosen, poiName?: string) => {
    Keyboard.dismiss();
    setProblem(null);
    setNote(null);
    setChosen(c);
    if (kind === 'custom' && name.trim() === '' && poiName && !isAddressLike(poiName)) setName(poiName.slice(0, PLACE_NAME_MAX));
    setMode('confirm');
  };

  const pickHit = (h: AddressHit) => choose({ title: h.title, subtitle: h.subtitle, lat: h.lat, lng: h.lng }, h.title);

  const pickSuggestion = async (s: Suggestion) => {
    const point = s.place.center;
    if (s.title !== null) {
      choose({ title: s.title, subtitle: s.subtitle, ...point });
      return;
    }
    // In a zone (never looked up on its own) or not found before: you picked it, so look it up now.
    setBusy('pick');
    const lines = await reverse(point);
    if (!live.current) return;
    setBusy(null);
    choose({ title: lines?.title ?? (s.zone ? copy.inZone(s.zone.name) : copy.unnamed), subtitle: lines?.subtitle ?? '', ...point });
  };

  const locateHere = async () => {
    setBusy('locate');
    setNote(null);
    const r = await locate();
    if (!live.current) return;
    if (!r.ok) {
      setBusy(null);
      setNote(r.reason === 'denied' ? copy.locationDenied : copy.locationFailed);
      return;
    }
    const lines = await reverse({ lat: r.lat, lng: r.lng });
    if (!live.current) return;
    setBusy(null);
    choose({ title: lines?.title ?? copy.unnamed, subtitle: lines?.subtitle ?? '', lat: r.lat, lng: r.lng });
  };

  const lookUp = async () => {
    if (q.length < MIN_QUERY) return;
    setBusy('exact');
    setNote(null);
    const hit = await exact(q);
    if (!live.current) return;
    setBusy(null);
    if (hit) pickHit(hit);
    else setNote(copy.exactFailed);
  };

  // A tap on the map moves the pin; the address follows when the phone can name the new spot.
  const moveTo = (p: LatLng) => {
    setChosen((c) => (c ? { ...c, lat: p.lat, lng: p.lng } : c));
    void reverse(p).then((lines) => {
      if (!live.current || !lines) return;
      setChosen((c) => (c && c.lat === p.lat && c.lng === p.lng ? { ...c, ...lines } : c));
    });
  };

  const save = async () => {
    if (!chosen) {
      setProblem('point');
      return;
    }
    const next: SavedPlace = {
      id: place?.id ?? idFor(kind),
      kind,
      name: kind === 'custom' ? name.trim() : FIXED_NAME[kind],
      address: chosen.title,
      area: chosen.subtitle,
      lat: chosen.lat,
      lng: chosen.lng,
    };
    const p = placeProblem(next);
    if (p) {
      setProblem(p);
      return;
    }
    setBusy('save');
    setSaveError(false);
    const ok = await onSave(next);
    if (!live.current) return;
    setBusy(null);
    if (ok) onClose();
    else setSaveError(true);
  };

  const remove = () => {
    if (!place) return;
    Alert.alert(copy.removeTitle(place.name), copy.removeBody, [
      { text: copy.cancel, style: 'cancel' },
      {
        text: copy.remove,
        style: 'destructive',
        onPress: () => {
          void onRemove(place).then((ok) => {
            if (!live.current) return;
            if (ok) onClose();
            else setSaveError(true);
          });
        },
      },
    ]);
  };

  const inputStyle = {
    minHeight: 48 * scale,
    borderWidth: 1.5,
    borderColor: th.colors.borderStrong,
    borderRadius: th.radius.md,
    paddingHorizontal: th.space.md,
    backgroundColor: th.colors.surface,
    color: th.colors.text,
    fontSize: 17 * scale,
  } as const;

  if (mode === 'confirm' && chosen) {
    const maps = loadMaps();
    const region = { latitude: chosen.lat, longitude: chosen.lng, latitudeDelta: 0.006, longitudeDelta: 0.006 };
    return (
      <View style={{ gap: th.space.lg, paddingBottom: th.space.lg }} testID="place-confirm">
        {maps ? (
          <View style={{ gap: th.space.xs }}>
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={{ height: 200, borderRadius: th.radius.lg, overflow: 'hidden', borderCurve: 'continuous' }}
            >
              <maps.default
                style={{ flex: 1 }}
                initialRegion={region}
                region={region}
                onPress={(e) => moveTo({ lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude })}
                showsPointsOfInterests={false}
                toolbarEnabled={false}
              >
                <maps.Marker coordinate={{ latitude: chosen.lat, longitude: chosen.lng }} pinColor={th.colors.accent} />
              </maps.default>
            </View>
            <Text variant="footnote" tone="muted">
              {copy.pinHint}
            </Text>
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', gap: th.space.md, alignItems: 'center' }}>
          <RowIcon name={placeIcon(kind)} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="headline" testID="place-address">
              {chosen.title}
            </Text>
            {chosen.subtitle ? (
              <Text variant="footnote" tone="muted">
                {chosen.subtitle}
              </Text>
            ) : null}
          </View>
        </View>

        {kind === 'custom' ? (
          <View style={{ gap: th.space.sm }}>
            <Text variant="headline">{copy.name}</Text>
            <TextInput
              testID="place-name"
              accessibilityLabel={copy.name}
              value={name}
              onChangeText={(v) => {
                setProblem(null);
                setName(v);
              }}
              placeholder={copy.namePlaceholder}
              placeholderTextColor={th.colors.textSubtle}
              maxLength={PLACE_NAME_MAX}
              allowFontScaling={false}
              autoCorrect={false}
              style={inputStyle}
            />
          </View>
        ) : null}

        {problem ? (
          <Text variant="callout" tone="danger" accessibilityRole="alert" testID="place-problem">
            {copy.problems[problem]}
          </Text>
        ) : null}
        {saveError ? (
          <Text variant="callout" tone="danger" accessibilityRole="alert" testID="place-save-error">
            {placesCopy.saveError}
          </Text>
        ) : null}

        <Button label={copy.save} onPress={() => void save()} loading={busy === 'save'} testID="place-save" />
        <Button
          label={copy.changeAddress}
          variant="secondary"
          size="md"
          icon="search"
          onPress={() => {
            setProblem(null);
            setQuery('');
            setMode('search');
          }}
          testID="place-change"
        />
        {place ? <Button label={copy.remove} variant="destructive" size="md" onPress={remove} testID="place-remove" /> : null}
      </View>
    );
  }

  const ql = q.toLowerCase();
  const allSuggestions = suggestions.data ?? [];
  const shownSuggestions =
    q.length >= MIN_QUERY ? allSuggestions.filter((s) => s.title !== null && `${s.title} ${s.subtitle}`.toLowerCase().includes(ql)) : allSuggestions;

  return (
    <View style={{ gap: th.space.lg, paddingBottom: th.space.lg }} testID="place-search">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm, ...inputStyle, paddingHorizontal: th.space.md }}>
        <Ionicons name="search" size={th.size.icon} color={th.colors.textMuted} accessibilityElementsHidden importantForAccessibility="no" />
        <TextInput
          testID="place-query"
          accessibilityLabel={copy.searchLabel}
          value={query}
          onChangeText={(v) => {
            setNote(null);
            setQuery(v);
          }}
          onSubmitEditing={() => void lookUp()}
          placeholder={copy.searchPlaceholder}
          placeholderTextColor={th.colors.textSubtle}
          autoFocus={!place}
          autoCorrect={false}
          autoComplete="street-address"
          textContentType="fullStreetAddress"
          returnKeyType="search"
          allowFontScaling={false}
          style={{ flex: 1, minHeight: 44 * scale, color: th.colors.text, fontSize: 17 * scale }}
        />
        {query.length > 0 ? (
          <Pressable accessibilityRole="button" accessibilityLabel={copy.clear} onPress={() => setQuery('')} hitSlop={th.space.sm} testID="place-clear">
            <Ionicons name="close-circle" size={th.size.icon} color={th.colors.textSubtle} />
          </Pressable>
        ) : null}
      </View>

      {note ? (
        <Text variant="footnote" tone="danger" accessibilityRole="alert" testID="place-note">
          {note}
        </Text>
      ) : null}

      {q.length < MIN_QUERY ? (
        <Section>
          <ListRow
            title={busy === 'locate' ? copy.locating : copy.useLocation}
            leading={<RowIcon name="locate" />}
            trailing={busy === 'locate' ? <ActivityIndicator color={th.colors.accent} /> : undefined}
            onPress={busy ? undefined : () => void locateHere()}
            testID="place-use-location"
          />
        </Section>
      ) : null}

      {shownSuggestions.length > 0 ? (
        <Section title={copy.fromDrives} testID="place-suggestions">
          {shownSuggestions.map((s) => (
            <ListRow
              key={s.place.id}
              title={s.title ?? (s.zone ? copy.inZone(s.zone.name) : copy.unnamed)}
              subtitle={[copy.why(s.place), s.subtitle].filter((x) => x !== '').join(' · ')}
              leading={<RowIcon name={s.place.kind === 'home' ? 'home-outline' : s.place.kind === 'work' ? 'briefcase-outline' : 'time-outline'} />}
              onPress={busy ? undefined : () => void pickSuggestion(s)}
              testID={`place-suggestion-${s.place.id}`}
            />
          ))}
        </Section>
      ) : null}

      {q.length >= MIN_QUERY ? (
        <Section title={copy.results} testID="place-results">
          {found.hits.map((h) => (
            <ListRow key={h.id} title={h.title} subtitle={h.subtitle || undefined} leading={<RowIcon name="location-outline" />} onPress={() => pickHit(h)} testID={`place-hit-${h.id}`} />
          ))}
          {found.state === 'loading' && found.hits.length === 0 ? (
            <ListRow title={copy.searching} leading={<ActivityIndicator color={th.colors.accent} />} testID="place-searching" />
          ) : null}
          {found.state === 'done' && found.hits.length === 0 ? <ListRow title={copy.noMatches} testID="place-no-matches" /> : null}
          {found.state === 'failed' ? <ListRow title={copy.searchFailed} testID="place-search-failed" /> : null}
          <ListRow
            title={copy.exact(q)}
            subtitle={copy.exactHint}
            leading={<RowIcon name="navigate-outline" />}
            trailing={busy === 'exact' ? <ActivityIndicator color={th.colors.accent} /> : undefined}
            onPress={busy ? undefined : () => void lookUp()}
            testID="place-exact"
          />
        </Section>
      ) : null}

      {busy === 'pick' ? <ActivityIndicator color={th.colors.accent} /> : null}

      <Text variant="caption" tone="muted">
        {copy.credit}
      </Text>
    </View>
  );
}

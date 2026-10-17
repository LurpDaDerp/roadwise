import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { Alert, TextInput, View } from 'react-native';

import { createPermissionsAdapter } from '@/core/permissions';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { Banner, Button, Chip, EmptyState, IconButton, ListRow, Screen, Sheet, Text, useFontScale, useTheme, withAlpha } from '@/ui';

import { settingsCopy } from './copy';
import { loadMaps, US_REGION } from './maps';
import { RowIcon, Section, TopBar } from './parts';
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
}

const EMPTY_DRAFT: Draft = { id: null, name: '', lat: null, lng: null, radiusM: DEFAULT_RADIUS_M };

function draftProblem(d: Draft): ZoneProblem | null {
  return zoneProblem({ name: d.name, lat: d.lat ?? NaN, lng: d.lng ?? NaN, radiusM: d.radiusM });
}

export interface PrivacyZonesDeps {
  locate?: () => Promise<LocateResult>;
}

/**
 * `/settings/privacy-zones`: up to 3 places whose surroundings never show on a map. Each zone is a
 * name, a centre (current location, or a tap on the map) and a 200–800 m radius set with a
 * stepper. Everything stays on this phone.
 */
export function PrivacyZonesScreen({ deps = {} }: { deps?: PrivacyZonesDeps }) {
  const th = useTheme();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const [zones, setZones] = useState<PrivacyZone[] | null>(null);
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

  return (
    <Screen scroll testID="privacy-zones-screen">
      <TopBar title={copy.title} />
      <Text variant="body">{copy.intro}</Text>
      {saveError ? <Banner tone="danger" message={copy.saveError} testID="zones-save-error" /> : null}

      {zones && zones.length > 0 ? (
        <Section footer={full ? copy.max : undefined} testID="zones-list">
          {zones.map((z) => (
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
      ) : zones ? (
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
        title={draft?.id ? copy.editTitle : copy.newTitle}
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
            problem={problem}
            locate={deps.locate ?? locateOnce}
            onSave={() => void onSave()}
            onRemove={
              draft.id ? () => onRemove(zones?.find((z) => z.id === draft.id) ?? (draft as PrivacyZone)) : undefined
            }
          />
        ) : null}
      </Sheet>
    </Screen>
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
  problem,
  locate,
  onSave,
  onRemove,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
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

  const locateHere = async () => {
    setLocating(true);
    setLocateError(null);
    const r = await locate();
    setLocating(false);
    if (r.ok) onChange({ ...draft, lat: r.lat, lng: r.lng });
    else setLocateError(r.reason);
  };

  return (
    <View style={{ gap: th.space.lg, paddingBottom: th.space.lg }}>
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
        {locateError ? (
          <Text variant="footnote" tone="danger" accessibilityRole="alert">
            {locateError === 'denied' ? copy.locationDenied : copy.locationFailed}
          </Text>
        ) : null}
        {maps ? (
          <>
            <Text variant="footnote" tone="muted">
              {copy.pickOnMap}
            </Text>
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
                onPress={(e) => onChange({ ...draft, lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude })}
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
        <Text variant="footnote" tone={hasCenter ? 'success' : 'muted'} testID="zone-center-status">
          {hasCenter ? copy.centerSet : copy.noCenter}
        </Text>
      </View>

      {problem ? (
        <Text variant="callout" tone="danger" accessibilityRole="alert" testID="zone-problem">
          {copy.problems[problem]}
        </Text>
      ) : null}

      <Button label={copy.save} onPress={onSave} testID="zone-save" />
      {onRemove ? <Button label={copy.remove} variant="destructive" size="md" onPress={onRemove} testID="zone-remove" /> : null}
    </View>
  );
}

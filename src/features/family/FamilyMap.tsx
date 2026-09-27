import { StyleSheet, View } from 'react-native';

import { loadMaps } from '@/features/trips/TripMap';
import { Text, tokens, useTheme } from '@/ui';

import type { FamilyMember, FamilyPlace } from './api';
import { familyCopy as copy } from './copy';
import { mapAvailable } from './parts';
import { memberName } from './presence';

const MAP_HEIGHT = 260;
/** Pins sit on map tiles, not on an app surface: light inks, as the trip map pins them. */
const INK = { member: tokens.color.light.accent, me: tokens.color.light.stamp, place: tokens.color.light.accent } as const;

interface Region {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

/** A region holding every point, with a margin; a lone point gets a street-level view. */
export function regionFor(points: readonly { lat: number; lng: number }[]): Region | null {
  if (points.length === 0) return null;
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * 1.4, 0.02),
    longitudeDelta: Math.max((maxLng - minLng) * 1.4, 0.02),
  };
}

/**
 * The family map: a pin for each member who shares a recent location and a circle for each place.
 * Never the only way to read it: the member list under it says where everyone is in words, so the
 * map is hidden from screen readers, and where a map cannot be drawn a single line says why.
 */
export function FamilyMap({ members, places }: { members: readonly FamilyMember[]; places: readonly FamilyPlace[] }) {
  const th = useTheme();
  const located = members.filter((m) => m.location !== null);
  const maps = mapAvailable() ? loadMaps() : null;
  if (!mapAvailable()) {
    return (
      <Text variant="footnote" tone="muted" testID="family-map-soon">
        {copy.home.mapAndroidSoon}
      </Text>
    );
  }
  const region = regionFor([...located.map((m) => m.location!), ...places]);
  if (maps === null || region === null) return null;
  const MapView = maps.default;
  const { Marker, Circle } = maps;
  return (
    <View
      testID="family-map"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        height: MAP_HEIGHT,
        borderRadius: th.radius.md,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: th.colors.border,
      }}
    >
      <MapView
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        showsUserLocation={false}
        showsMyLocationButton={false}
        toolbarEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
      >
        {places.map((p) => (
          <Circle
            key={`place-${p.id}`}
            center={{ latitude: p.lat, longitude: p.lng }}
            radius={p.radiusM}
            strokeColor={INK.place}
            fillColor={`${INK.place}22`}
            strokeWidth={2}
          />
        ))}
        {places.map((p) => (
          <Marker
            key={`place-pin-${p.id}`}
            coordinate={{ latitude: p.lat, longitude: p.lng }}
            title={p.name}
            opacity={0.8}
            pinColor={INK.place}
          />
        ))}
        {located.map((m) => (
          <Marker
            key={m.userId}
            coordinate={{ latitude: m.location!.lat, longitude: m.location!.lng }}
            title={memberName(m)}
            pinColor={m.isMe ? INK.me : INK.member}
            testID={`family-pin-${m.userId}`}
          />
        ))}
      </MapView>
    </View>
  );
}

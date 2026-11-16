/**
 * How a map looks on Android, so it matches the iPhone's Apple map (WP09). Google's map on Android
 * differs from Apple's in two ways this fixes:
 *
 * - **Points of interest.** `showsPointsOfInterests={false}` hides Apple's shop and transit-stop
 *   pins; react-native-maps ignores it on Android. A style hides the same labels and icons there
 *   (parks and water keep their colour, as on Apple's map).
 * - **Dark.** Apple's map follows the scheme it is given live. react-native-maps reads Android's
 *   colour scheme only when the map is created, so a map is given a dark style and remounted (its
 *   `key`) when the scheme flips: the same dark greys as Apple's dark map (#242424 land, the tiles
 *   the route inks were checked against), roads a step lighter, water a deep blue-grey.
 *
 * iPhone gets nothing from here: its maps keep their own props.
 */
import { Platform } from 'react-native';
import type { MapStyleElement } from 'react-native-maps';

export type MapScheme = 'light' | 'dark';

/** Shop, school and transit-stop labels and icons off; their areas (a park's green) stay. */
const QUIET: MapStyleElement[] = [
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit.station', elementType: 'labels', stylers: [{ visibility: 'off' }] },
];

/** A neutral dark map, Apple's dark greys (land #242424, roads #3A3A3A to #505050). */
const DARK: MapStyleElement[] = [
  { elementType: 'geometry', stylers: [{ color: '#242424' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#9A9A9A' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1A1A1A' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#4A4A4A' }] },
  { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#C4C4C4' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#2B2B2B' }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#2B2B2B' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#22302A' }] },
  { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: '#3A3A3A' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#1F1F1F' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#A8A8A8' }] },
  { featureType: 'road.arterial', elementType: 'geometry.fill', stylers: [{ color: '#444444' }] },
  { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: '#505050' }] },
  { featureType: 'road.local', elementType: 'labels.text.fill', stylers: [{ color: '#7E7E7E' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#333333' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#17212B' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#5A6A7A' }] },
];

/** The style JSON for a scheme: the quiet map, dark when asked. */
export function mapStyleFor(scheme: MapScheme): MapStyleElement[] {
  return scheme === 'dark' ? [...DARK, ...QUIET] : QUIET;
}

const STYLES: Record<MapScheme, MapStyleElement[]> = { light: mapStyleFor('light'), dark: mapStyleFor('dark') };

/**
 * The props an Android map takes to look as it does on iPhone, for the scheme the iPhone map shows:
 * the scheme at creation, the style, and the key that remounts the map when the scheme flips. Null
 * on iPhone (and anywhere but Android), where the map keeps its own props.
 */
export function androidMapLook(scheme: MapScheme, os: string = Platform.OS): { key: string; userInterfaceStyle: MapScheme; customMapStyle: MapStyleElement[] } | null {
  if (os !== 'android') return null;
  return { key: `map-${scheme}`, userInterfaceStyle: scheme, customMapStyle: STYLES[scheme] };
}

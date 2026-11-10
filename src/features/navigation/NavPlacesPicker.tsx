// "Where to?": the driving screen's list of the driver's saved places (Home, Work, School, then
// their own, in that order), each a tap away from driving directions in the saved navigation app,
// then "Open {app}", which opens that app as a plain tap would. It shows in the same panel as the
// list of apps, with the same rows (64 pt at least) and the caller's colours. The title and the
// drive line stay put above the rows, which scroll in their own window, and Cancel sits under
// them. Where that window has no room for one whole row (larger text, a very short panel) the list
// is short instead: only Cancel is pinned and the rest scrolls as one list, so the first place is
// always in reach.
import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { PlaceKind, SavedPlace } from '@/features/places/model';
import { panelStyles as ps, panelTones, pressedLook, PANEL_ICON_PT } from '@/ui/drive/panelLook';

import type { InstalledNavApp } from './apps';
import { navCopy } from './copy';
import { NAV_ROW_MIN_PT, useShortNavList, type NavPickerColors } from './NavAppPicker';

const PLACE_ICON: Record<PlaceKind, keyof typeof Ionicons.glyphMap> = {
  home: 'home-outline',
  work: 'briefcase-outline',
  school: 'school-outline',
  custom: 'location-outline',
};

/** The row's second line: the address, else its city line, else nothing. */
export const placeSubtitle = (place: Pick<SavedPlace, 'address' | 'area'>): string => place.address.trim() || place.area.trim();

export function NavPlacesPicker({
  app,
  places,
  colors,
  onGo,
  onOpenApp,
  onClose,
}: {
  /** The saved app the rows open. */
  app: InstalledNavApp;
  places: readonly SavedPlace[];
  colors: NavPickerColors;
  onGo(place: SavedPlace): void;
  onOpenApp(): void;
  onClose(): void;
}) {
  const hint = navCopy.placeHint(app.label);
  const c = panelTones(colors);
  const chevron = <Ionicons name="chevron-forward" size={20} color={c.muted} accessibilityElementsHidden importantForAccessibility="no" />;
  const [short, rowsRef, onRowsLayout] = useShortNavList();
  const header = (
    <View style={ps.header}>
      <Text accessibilityRole="header" style={[ps.title, { color: c.ink }]}>
        {navCopy.placesTitle}
      </Text>
      <Text style={[ps.line, { color: c.muted }]}>{navCopy.driveLine}</Text>
    </View>
  );
  const rows = (
    <>
      {places.map((place) => {
        const sub = placeSubtitle(place);
        return (
          <Pressable
            key={place.id}
            testID={`nav-picker-place-${place.id}`}
            accessibilityRole="button"
            accessibilityLabel={navCopy.placeLabel(place.name, sub)}
            accessibilityHint={hint}
            onPress={() => onGo(place)}
            style={({ pressed }) => [ps.row, styles.row, { backgroundColor: c.raised, borderColor: c.raised }, pressedLook(pressed)]}
          >
            <View style={[ps.badge, { backgroundColor: c.accentFaint }]}>
              <Ionicons name={PLACE_ICON[place.kind]} size={PANEL_ICON_PT} color={c.accent} />
            </View>
            <View style={ps.rowText}>
              <Text numberOfLines={1} style={[ps.rowLabel, { color: c.ink }]}>
                {place.name}
              </Text>
              {sub !== '' ? (
                <Text numberOfLines={1} style={[ps.rowSub, { color: c.muted }]}>
                  {sub}
                </Text>
              ) : null}
            </View>
            {chevron}
          </Pressable>
        );
      })}
      <Pressable
        testID="nav-picker-open-app"
        accessibilityRole="button"
        accessibilityLabel={navCopy.openLabel(app.label)}
        onPress={onOpenApp}
        style={({ pressed }) => [ps.row, styles.row, { backgroundColor: c.surface, borderColor: c.edge }, pressedLook(pressed)]}
      >
        <View style={[ps.badge, { backgroundColor: c.accentFaint }]}>
          <Ionicons name="navigate" size={PANEL_ICON_PT} color={c.accent} />
        </View>
        <Text numberOfLines={1} style={[ps.rowLabel, ps.rowText, { color: c.ink }]}>
          {navCopy.openLabel(app.label)}
        </Text>
        {chevron}
      </Pressable>
    </>
  );
  return (
    <View testID="nav-picker" style={styles.root}>
      {short ? (
        <ScrollView testID="nav-picker-scroll" style={styles.list} contentContainerStyle={styles.body}>
          {header}
          <View testID="nav-picker-places" style={styles.rows}>
            {rows}
          </View>
        </ScrollView>
      ) : (
        <>
          {header}
          <ScrollView ref={rowsRef} testID="nav-picker-places" onLayout={onRowsLayout} style={styles.list} contentContainerStyle={styles.rows}>
            {rows}
          </ScrollView>
        </>
      )}
      <Pressable
        testID="nav-picker-close"
        accessibilityRole="button"
        accessibilityLabel={navCopy.cancel}
        onPress={onClose}
        style={({ pressed }) => [ps.capsule, { borderColor: c.edge, backgroundColor: c.surface }, pressedLook(pressed)]}
      >
        <Text style={[ps.capsuleLabel, { color: c.ink }]}>{navCopy.cancel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12, flexShrink: 1 },
  list: { flexGrow: 0, flexShrink: 1 },
  body: { gap: 12 },
  rows: { gap: 8 },
  row: { minHeight: NAV_ROW_MIN_PT },
});

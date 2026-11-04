// "Where to?": the driving screen's list of the driver's saved places (Home, Work, School, then
// their own, in that order), each a tap away from driving directions in the saved navigation app,
// then "Open {app}", which opens that app as a plain tap would. It shows in the same panel as the
// list of apps, with the same rows (64 pt at least) and the caller's colours.
import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { PlaceKind, SavedPlace } from '@/features/places/model';
import { fontFamilies } from '@/ui/fonts';

import type { InstalledNavApp } from './apps';
import { navCopy } from './copy';
import { NAV_ROW_MIN_PT, type NavPickerColors } from './NavAppPicker';

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
  return (
    <View testID="nav-picker" style={styles.root}>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
        {navCopy.placesTitle}
      </Text>
      <Text style={[styles.line, { color: colors.muted }]}>{navCopy.driveLine}</Text>
      <ScrollView testID="nav-picker-places" style={styles.list} contentContainerStyle={styles.listBody}>
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
              style={({ pressed }) => [styles.row, { borderColor: colors.edge, opacity: pressed ? 0.7 : 1 }]}
            >
              <Ionicons name={PLACE_ICON[place.kind]} size={24} color={colors.ink} />
              <View style={styles.rowText}>
                <Text numberOfLines={1} style={[styles.rowLabel, { color: colors.ink }]}>
                  {place.name}
                </Text>
                {sub !== '' ? (
                  <Text numberOfLines={1} style={[styles.rowSub, { color: colors.muted }]}>
                    {sub}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
        <Pressable
          testID="nav-picker-open-app"
          accessibilityRole="button"
          accessibilityLabel={navCopy.openLabel(app.label)}
          onPress={onOpenApp}
          style={({ pressed }) => [styles.row, { borderColor: colors.edge, opacity: pressed ? 0.7 : 1 }]}
        >
          <Ionicons name="navigate" size={24} color={colors.ink} />
          <Text numberOfLines={1} style={[styles.rowLabel, styles.rowText, { color: colors.ink }]}>
            {navCopy.openLabel(app.label)}
          </Text>
        </Pressable>
      </ScrollView>
      <Pressable
        testID="nav-picker-close"
        accessibilityRole="button"
        accessibilityLabel={navCopy.cancel}
        onPress={onClose}
        style={({ pressed }) => [styles.close, { borderColor: colors.edge, opacity: pressed ? 0.7 : 1 }]}
      >
        <Text style={[styles.closeLabel, { color: colors.ink }]}>{navCopy.cancel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12, flexShrink: 1 },
  title: { fontFamily: fontFamilies.headline, fontSize: 22, lineHeight: 28 },
  line: { fontFamily: fontFamilies.ui, fontSize: 16, lineHeight: 22 },
  list: { flexGrow: 0, flexShrink: 1 },
  listBody: { gap: 8 },
  row: {
    minHeight: NAV_ROW_MIN_PT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 14,
    borderWidth: 1,
  },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontFamily: fontFamilies.headline, fontSize: 19 },
  rowSub: { fontFamily: fontFamilies.ui, fontSize: 15, lineHeight: 20 },
  close: { minHeight: 56, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1 },
  closeLabel: { fontFamily: fontFamilies.headline, fontSize: 18 },
});

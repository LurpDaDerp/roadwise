// "Select default navigation app": the list of the navigation apps installed on this phone. The
// driving screen shows it in a panel over the HUD (never a route, and the End button stays
// reachable below it); Settings shows it in a sheet. The colours are the caller's, so the HUD keeps
// its own palette.
import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { fontFamilies } from '@/ui/fonts';

import type { InstalledNavApp } from './apps';
import type { NavAppId } from './catalog';
import { navCopy } from './copy';

/** A row of the list: at least this tall (64 pt: HUD touch targets). */
export const NAV_ROW_MIN_PT = 64;

export interface NavPickerColors {
  surface: string;
  ink: string;
  muted: string;
  edge: string;
}

export function NavAppPicker({
  apps,
  mode,
  missingLabel,
  driveLine,
  selected = null,
  colors,
  onChoose,
  onClose,
}: {
  apps: readonly InstalledNavApp[];
  mode: 'first' | 'gone' | 'failed' | 'change' | 'settings';
  /** The app the gone / failed line names. */
  missingLabel?: string;
  /** The line about points (the driving screen only). */
  driveLine: boolean;
  /** The saved app, marked (Settings, and the driving screen's long press). */
  selected?: NavAppId | null;
  colors: NavPickerColors;
  onChoose(app: InstalledNavApp): void;
  onClose(): void;
}) {
  const notice = missingLabel === undefined ? null : mode === 'gone' ? navCopy.gone(missingLabel) : mode === 'failed' ? navCopy.failed(missingLabel) : null;
  return (
    <View testID="nav-picker" style={styles.root}>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
        {navCopy.pickerTitle}
      </Text>
      {driveLine ? <Text style={[styles.line, { color: colors.muted }]}>{navCopy.driveLine}</Text> : null}
      {notice !== null ? (
        <Text testID="nav-picker-notice" accessibilityRole="alert" style={[styles.line, { color: colors.ink }]}>
          {notice}
        </Text>
      ) : null}
      {apps.length === 0 ? (
        <Text testID="nav-picker-empty" style={[styles.line, { color: colors.ink }]}>
          {navCopy.empty}
        </Text>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listBody}>
          {apps.map((app) => {
            const isSelected = selected === app.id;
            return (
              <Pressable
                key={app.id}
                testID={`nav-picker-row-${app.id}`}
                accessibilityRole="button"
                accessibilityLabel={app.label}
                accessibilityState={{ selected: isSelected }}
                onPress={() => onChoose(app)}
                style={({ pressed }) => [styles.row, { borderColor: colors.edge, opacity: pressed ? 0.7 : 1 }]}
              >
                <Ionicons name="navigate" size={24} color={colors.ink} />
                <Text numberOfLines={1} style={[styles.rowLabel, { color: colors.ink }]}>
                  {app.label}
                </Text>
                {isSelected ? <Ionicons name="checkmark" size={24} color={colors.ink} accessibilityLabel={navCopy.selected} /> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      )}
      <Text style={[styles.footer, { color: colors.muted }]}>{navCopy.footer}</Text>
      <Pressable
        testID="nav-picker-close"
        accessibilityRole="button"
        accessibilityLabel={apps.length === 0 ? navCopy.close : navCopy.cancel}
        onPress={onClose}
        style={({ pressed }) => [styles.close, { borderColor: colors.edge, opacity: pressed ? 0.7 : 1 }]}
      >
        <Text style={[styles.closeLabel, { color: colors.ink }]}>{apps.length === 0 ? navCopy.close : navCopy.cancel}</Text>
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
    borderRadius: 14,
    borderWidth: 1,
  },
  rowLabel: { flex: 1, fontFamily: fontFamilies.headline, fontSize: 19 },
  footer: { fontFamily: fontFamilies.ui, fontSize: 14, lineHeight: 20 },
  close: { minHeight: 56, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1 },
  closeLabel: { fontFamily: fontFamilies.headline, fontSize: 18 },
});

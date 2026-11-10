// "Choose your navigation app": the list of the navigation apps installed on this phone. The
// driving screen shows it in a panel over the HUD (never a route, and the End button stays
// reachable below it); Settings shows it in a sheet. The colours are the caller's, so the HUD keeps
// its own palette. Only Cancel / Close is pinned: the title, the notice, the rows and the footer
// scroll as one list, so a short panel (an iPhone SE, larger text) always reaches the first app.
import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { fontFamilies } from '@/ui/fonts';
import { panelStyles as ps, panelTones, pressedLook, PANEL_ICON_PT, type PanelColors } from '@/ui/drive/panelLook';

import type { InstalledNavApp } from './apps';
import type { NavAppId } from './catalog';
import { navCopy } from './copy';

/** A row of the list: at least this tall (64 pt: HUD touch targets). */
export const NAV_ROW_MIN_PT = 64;

/** The panel's colours (`PanelColors`): the caller's, so the HUD keeps its own palette. */
export type NavPickerColors = PanelColors;

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
  /** "Your drive keeps recording while you navigate." (the driving screen only). */
  driveLine: boolean;
  /** The saved app, marked (Settings, and the driving screen's long press). */
  selected?: NavAppId | null;
  colors: NavPickerColors;
  onChoose(app: InstalledNavApp): void;
  onClose(): void;
}) {
  const notice = missingLabel === undefined ? null : mode === 'gone' ? navCopy.gone(missingLabel) : mode === 'failed' ? navCopy.failed(missingLabel) : null;
  const c = panelTones(colors);
  const closeLabel = apps.length === 0 ? navCopy.close : navCopy.cancel;
  return (
    <View testID="nav-picker" style={styles.root}>
      <ScrollView testID="nav-picker-scroll" style={styles.list} contentContainerStyle={styles.body}>
        <View style={ps.header}>
          <Text accessibilityRole="header" style={[ps.title, { color: c.ink }]}>
            {navCopy.pickerTitle}
          </Text>
          {driveLine ? (
            <Text style={[ps.line, { color: c.muted }]}>
              {navCopy.driveLine}
            </Text>
          ) : null}
        </View>
        {notice !== null ? (
          <View style={[styles.notice, { backgroundColor: c.accentFaint }]}>
            <Ionicons name="information-circle" size={PANEL_ICON_PT} color={c.accent} />
            <Text testID="nav-picker-notice" accessibilityRole="alert" style={[ps.line, styles.noticeText, { color: c.ink }]}>
              {notice}
            </Text>
          </View>
        ) : null}
        {apps.length === 0 ? (
          <Text testID="nav-picker-empty" style={[ps.line, { color: c.ink }]}>
            {navCopy.empty}
          </Text>
        ) : (
          <View testID="nav-picker-rows" style={styles.rows}>
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
                  style={({ pressed }) => [
                    ps.row,
                    styles.row,
                    { backgroundColor: isSelected ? c.accentFaint : c.raised, borderColor: isSelected ? c.accent : c.raised },
                    pressedLook(pressed),
                  ]}
                >
                  <View style={[ps.badge, { backgroundColor: isSelected ? c.surface : c.accentFaint }]}>
                    <Ionicons name="navigate" size={PANEL_ICON_PT} color={c.accent} />
                  </View>
                  <Text numberOfLines={1} style={[ps.rowLabel, ps.rowText, { color: c.ink }]}>
                    {app.label}
                  </Text>
                  {isSelected ? (
                    <Ionicons name="checkmark-circle" size={26} color={c.accent} accessibilityLabel={navCopy.selected} />
                  ) : (
                    <Ionicons name="chevron-forward" size={20} color={c.muted} accessibilityElementsHidden importantForAccessibility="no" />
                  )}
                </Pressable>
              );
            })}
          </View>
        )}
        <Text style={[styles.footer, { color: c.muted }]}>
          {navCopy.footer}
        </Text>
      </ScrollView>
      <Pressable
        testID="nav-picker-close"
        accessibilityRole="button"
        accessibilityLabel={closeLabel}
        onPress={onClose}
        style={({ pressed }) => [ps.capsule, { borderColor: c.edge, backgroundColor: c.surface }, pressedLook(pressed)]}
      >
        <Text style={[ps.capsuleLabel, { color: c.ink }]}>
          {closeLabel}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12, flexShrink: 1 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 16, borderCurve: 'continuous' },
  noticeText: { flex: 1 },
  list: { flexGrow: 0, flexShrink: 1 },
  body: { gap: 12 },
  rows: { gap: 8 },
  row: { minHeight: NAV_ROW_MIN_PT },
  footer: { fontFamily: fontFamilies.ui, fontSize: 13, lineHeight: 18, textAlign: 'center' },
});

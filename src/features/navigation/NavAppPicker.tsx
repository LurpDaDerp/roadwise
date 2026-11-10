// "Choose your navigation app": the list of the navigation apps installed on this phone. The
// driving screen shows it in a panel over the HUD (never a route, and the End button stays
// reachable below it); Settings shows it in a sheet. The colours are the caller's, so the HUD keeps
// its own palette. The title, the notice and the footer stay put around the rows, which scroll in
// their own window, and Cancel sits under them. Where that window has no room for one whole row (an
// iPhone SE, larger text) the list is short instead: only Cancel is pinned and the rest scrolls as
// one list, so the first app is always in reach. With no app to list there are no rows to window:
// the lines sit still when the panel holds them and scroll above Close when it does not.
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { fontFamilies } from '@/ui/fonts';
import { panelStyles as ps, panelTones, pressedLook, PANEL_ICON_PT, type PanelColors } from '@/ui/drive/panelLook';

import type { InstalledNavApp } from './apps';
import type { NavAppId } from './catalog';
import { navCopy } from './copy';

/** A row of the list: at least this tall (64 pt: HUD touch targets). */
export const NAV_ROW_MIN_PT = 64;

/** The panel's colours (`PanelColors`): the caller's, so the HUD keeps its own palette. */
export type NavPickerColors = PanelColors;

/** A window this close to a row's height holds the row: a pixel of rounding is not a missing row. */
const ROW_FIT_SLACK_PT = 0.5;

/**
 * Whether a navigation list is short, with the ref and the `onLayout` of its rows' window, which
 * decide it: the list turns short when the window measures less than one whole row. The ref
 * measures the window as it mounts, before the list is drawn, so a short panel opens short;
 * `onLayout` follows a window that changes size afterwards. A short list stays short until it
 * leaves the screen, so the two layouts never trade places back and forth.
 */
export function useShortNavList(): [short: boolean, rowsRef: (rows: ScrollView | null) => void, onRowsLayout: (e: LayoutChangeEvent) => void] {
  const [short, setShort] = useState(false);
  const fit = useCallback((height: number) => {
    if (height < NAV_ROW_MIN_PT - ROW_FIT_SLACK_PT) setShort(true);
  }, []);
  const rowsRef = useCallback(
    (rows: ScrollView | null) => {
      // A window with no width has no layout yet: its `onLayout` decides.
      rows?.getNativeScrollRef()?.measure((_x, _y, width, height) => {
        if (width > 0) fit(height);
      });
    },
    [fit]
  );
  const onRowsLayout = useCallback((e: LayoutChangeEvent) => fit(e.nativeEvent.layout.height), [fit]);
  return [short, rowsRef, onRowsLayout];
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
  const empty = apps.length === 0;
  const closeLabel = empty ? navCopy.close : navCopy.cancel;
  const [short, rowsRef, onRowsLayout] = useShortNavList();
  const header = (
    <View style={ps.header}>
      <Text accessibilityRole="header" style={[ps.title, { color: c.ink }]}>
        {navCopy.pickerTitle}
      </Text>
      {driveLine ? <Text style={[ps.line, { color: c.muted }]}>{navCopy.driveLine}</Text> : null}
    </View>
  );
  const noticeBox =
    notice !== null ? (
      <View style={[styles.notice, { backgroundColor: c.accentFaint }]}>
        <Ionicons name="information-circle" size={PANEL_ICON_PT} color={c.accent} />
        <Text testID="nav-picker-notice" accessibilityRole="alert" style={[ps.line, styles.noticeText, { color: c.ink }]}>
          {notice}
        </Text>
      </View>
    ) : null;
  const rows = apps.map((app) => {
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
  });
  const footer = <Text style={[styles.footer, { color: c.muted }]}>{navCopy.footer}</Text>;
  return (
    <View testID="nav-picker" style={styles.root}>
      {short || empty ? (
        // One list above the pinned Cancel / Close. An empty list's lines only move when they overflow.
        <ScrollView testID="nav-picker-scroll" alwaysBounceVertical={!empty} style={styles.list} contentContainerStyle={styles.body}>
          {header}
          {noticeBox}
          {empty ? (
            <Text testID="nav-picker-empty" style={[ps.line, { color: c.ink }]}>
              {navCopy.empty}
            </Text>
          ) : (
            <View testID="nav-picker-rows" style={styles.rows}>
              {rows}
            </View>
          )}
          {footer}
        </ScrollView>
      ) : (
        <>
          {header}
          {noticeBox}
          <ScrollView ref={rowsRef} testID="nav-picker-rows" onLayout={onRowsLayout} style={styles.list} contentContainerStyle={styles.rows}>
            {rows}
          </ScrollView>
          {footer}
        </>
      )}
      <Pressable
        testID="nav-picker-close"
        accessibilityRole="button"
        accessibilityLabel={closeLabel}
        onPress={onClose}
        style={({ pressed }) => [ps.capsule, { borderColor: c.edge, backgroundColor: c.surface }, pressedLook(pressed)]}
      >
        <Text style={[ps.capsuleLabel, { color: c.ink }]}>{closeLabel}</Text>
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

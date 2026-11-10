// The emergency panel (the emergency button's): in the panel slot the navigation list and the
// waiting panel use, ahead of both, in the app's sheet colours. "Emergency call" over a large red
// "Call 911", then one row per saved contact (the name, the number under it), at least 64 pt each,
// or "Add contacts in Settings." with none (plain words: nothing here leaves the drive), then Close.
// A tap on 911 or a contact hands the number to the phone's call screen (`placeCall`) and the screen
// closes the panel; a call that didn't start keeps it open and says so. "Call 911" never shrinks or
// scrolls away: in a tall panel it sits under the title with the contacts scrolling between it and
// Close; in a short one (an iPhone SE, larger text or a split-screen window: too short to show the
// title, "Call 911", a whole contact row and Close at the text size in use) the title is only read
// out and everything scrolls, "Call 911" first, Close last. Numbers read as in Settings (`formatPhone`).
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { EMERGENCY_NUMBER, formatPhone, type EmergencyContact } from '@/features/emergency/model';
import { ensureGround } from '@/ui';
import { HUD_MIN_TARGET_PT, type HudPalette } from '@/ui/drive';
import { panelStyles as ps, panelTones, pressedLook, PANEL_CAPSULE_PT, PANEL_ICON_PT } from '@/ui/drive/panelLook';
import { fontFamilies } from '@/ui/fonts';

import { hudCopy } from './hudCopy';
import type { WaitPanelColors } from './WaitPanel';

/** The white label on the 911 button holds 7:1 (the HUD's print rule) on its red. */
const CALL_INK = '#FFFFFF';
export const SOS_CALL_MIN = 7;
/** The "Call 911" button's height. */
export const SOS_CALL_H_PT = HUD_MIN_TARGET_PT + 8;
/** The padding and border around the panel in its slot (16 + 1 pt a side, the HUD's and the crash screen's). */
export const SOS_PANEL_INSET_PT = 2 * (16 + 1);

/**
 * Whether a panel `height` tall (its slot, padding and border included) shows the title with
 * "Call 911" and Close pinned and room for one whole contact row between them, at this font scale.
 * Otherwise it drops the visible title and scrolls as one list.
 */
export function sosPanelTall(height: number, fontScale: number): boolean {
  const s = Number.isFinite(fontScale) ? Math.max(fontScale, 1) : 1;
  const title = 28 * s * (s > 1.5 ? 2 : 1); // "Emergency call" wraps at the largest sizes
  const close = Math.max(PANEL_CAPSULE_PT, Math.ceil(17 * 1.2 * s));
  const row = Math.max(HUD_MIN_TARGET_PT, (23 + 2 + 19) * s + 2 * 10 + 2 * 1.5);
  return height - SOS_PANEL_INSET_PT >= title + SOS_CALL_H_PT + row + close + 3 * 12;
}

/** The 911 button's red: the sign ring's, deepened until white print reads on it at 7:1. */
export function sosCallFace(p: HudPalette): string {
  return ensureGround(p.signRing, [CALL_INK], SOS_CALL_MIN, '#000000');
}

export function EmergencyPanel({
  contacts,
  palette,
  colors,
  height,
  onCall,
  onClose,
}: {
  /** The saved contacts, or undefined while they are still being read. */
  contacts: readonly EmergencyContact[] | undefined;
  palette: HudPalette;
  colors: WaitPanelColors;
  /** The panel's slot height, padding and border included (`hudLayout` `sosPanel.h`): a short one scrolls as one list. */
  height: number;
  /** Places the call; false when the call screen didn't open. */
  onCall(phone: string): Promise<boolean>;
  onClose(): void;
}) {
  const c = panelTones(colors);
  const { fontScale } = useWindowDimensions();
  const red = useMemo(() => sosCallFace(palette), [palette]);
  const [failed, setFailed] = useState(false);
  const call = (phone: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setFailed(false);
    void onCall(phone).then((ok) => {
      if (!ok) setFailed(true);
    });
  };

  // Its title read out once as it opens.
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility?.(hudCopy.sos.title);
  }, []);

  const tall = sosPanelTall(height, fontScale);

  const call911 = (
    <Pressable
      testID="hud-sos-911"
      accessibilityRole="button"
      accessibilityLabel={hudCopy.sos.call911}
      accessibilityHint={hudCopy.sos.call911Hint}
      onPress={() => call(EMERGENCY_NUMBER)}
      style={({ pressed }) => [styles.call, { backgroundColor: red }, pressedLook(pressed)]}
    >
      <View style={styles.callBadge}>
        <Ionicons name="call" size={24} color={CALL_INK} />
      </View>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} style={[styles.callLabel, { color: CALL_INK }]}>
        {hudCopy.sos.call911}
      </Text>
    </Pressable>
  );
  const rest = (
    <>
      {failed ? (
        <Text testID="hud-sos-failed" accessibilityRole="alert" style={[ps.line, { color: c.ink }]}>
          {hudCopy.sos.failed}
        </Text>
      ) : null}
      {contacts === undefined ? null : contacts.length === 0 ? (
        <Text testID="hud-sos-none" style={[ps.line, styles.none, { color: c.muted }]}>
          {hudCopy.sos.none}
        </Text>
      ) : (
        contacts.map((contact) => {
          const number = formatPhone(contact.phone);
          return (
            <Pressable
              key={contact.id}
              testID={`hud-sos-contact-${contact.id}`}
              accessibilityRole="button"
              accessibilityLabel={hudCopy.sos.contactLabel(contact.name, number)}
              onPress={() => call(contact.phone)}
              style={({ pressed }) => [ps.row, styles.row, { backgroundColor: c.raised, borderColor: c.raised }, pressedLook(pressed)]}
            >
              <View style={[ps.badge, { backgroundColor: c.accentFaint }]}>
                <Ionicons name="call-outline" size={PANEL_ICON_PT} color={c.accent} />
              </View>
              <View style={ps.rowText}>
                <Text numberOfLines={1} style={[ps.rowLabel, { color: c.ink }]}>
                  {contact.name}
                </Text>
                <Text numberOfLines={1} style={[ps.rowSub, { color: c.muted }]}>
                  {number}
                </Text>
              </View>
            </Pressable>
          );
        })
      )}
    </>
  );
  const close = (
    <Pressable
      testID="hud-sos-close"
      accessibilityRole="button"
      accessibilityLabel={hudCopy.sos.close}
      accessibilityHint={hudCopy.sos.closeHint}
      onPress={onClose}
      style={({ pressed }) => [ps.capsule, { borderColor: c.edge, backgroundColor: c.surface }, pressedLook(pressed)]}
    >
      <Text style={[ps.capsuleLabel, { color: c.ink }]}>
        {hudCopy.sos.close}
      </Text>
    </Pressable>
  );

  if (!tall)
    return (
      <ScrollView testID="hud-sos-panel" style={styles.root} contentContainerStyle={styles.listBody}>
        {call911}
        {rest}
        {close}
      </ScrollView>
    );
  return (
    <View testID="hud-sos-panel" style={[styles.root, styles.tall]}>
      <Text accessibilityRole="header" style={[ps.title, { color: c.ink }]}>
        {hudCopy.sos.title}
      </Text>
      {call911}
      <ScrollView style={styles.list} contentContainerStyle={styles.listBody}>
        {rest}
      </ScrollView>
      {close}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  tall: { gap: 12 },
  list: { flexGrow: 0, flexShrink: 1 },
  listBody: { gap: 8 },
  call: {
    minHeight: SOS_CALL_H_PT,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    borderRadius: 22,
    borderCurve: 'continuous',
    paddingHorizontal: 16,
  },
  callBadge: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255, 255, 255, 0.18)' },
  callLabel: { flexShrink: 1, fontFamily: fontFamilies.headline, fontSize: 22 },
  none: { textAlign: 'center', paddingVertical: 4 },
  row: { minHeight: HUD_MIN_TARGET_PT },
});

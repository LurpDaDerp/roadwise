// The emergency panel (the emergency button's): in the panel slot the navigation list and the
// waiting panel use, ahead of both, in the app's sheet colours. "Emergency call" over a large red
// "Call 911", then one row per saved contact (the name, the number under it), at least 64 pt each,
// or "Add contacts in Settings." with none (plain words: nothing here leaves the drive), then Close.
// A tap on 911 or a contact hands the number to the phone's call screen (`placeCall`) and the screen
// closes the panel; a call that didn't start keeps it open and says so. "Call 911" never shrinks or
// scrolls away: in a tall panel it sits under the title with the contacts scrolling between it and
// Close; in a short one (a split-screen window) the title is only read out and everything scrolls,
// "Call 911" first, Close last. Numbers read as in Settings (`formatPhone`).
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { EMERGENCY_NUMBER, formatPhone, type EmergencyContact } from '@/features/emergency/model';
import { ensureGround } from '@/ui';
import { HUD_MIN_TARGET_PT, type HudPalette } from '@/ui/drive';
import { fontFamilies } from '@/ui/fonts';

import { hudCopy } from './hudCopy';
import type { WaitPanelColors } from './WaitPanel';

/** The white label on the 911 button holds 7:1 (the HUD's print rule) on its red. */
const CALL_INK = '#FFFFFF';
export const SOS_CALL_MIN = 7;
/** The "Call 911" button's height. */
export const SOS_CALL_H_PT = HUD_MIN_TARGET_PT + 8;
/** Under this height the panel drops its visible title and scrolls as one list. */
export const SOS_PANEL_TALL_PT = 260;

/** The 911 button's red: the sign ring's, deepened until white print reads on it at 7:1. */
export function sosCallFace(p: HudPalette): string {
  return ensureGround(p.signRing, [CALL_INK], SOS_CALL_MIN, '#000000');
}

export function EmergencyPanel({
  contacts,
  palette,
  colors: c,
  height,
  onCall,
  onClose,
}: {
  /** The saved contacts, or undefined while they are still being read. */
  contacts: readonly EmergencyContact[] | undefined;
  palette: HudPalette;
  colors: WaitPanelColors;
  /** The panel's height (`hudLayout` `sosPanel.h`): a short one scrolls as one list. */
  height: number;
  /** Places the call; false when the call screen didn't open. */
  onCall(phone: string): Promise<boolean>;
  onClose(): void;
}) {
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

  const tall = height >= SOS_PANEL_TALL_PT;

  const call911 = (
    <Pressable
      testID="hud-sos-911"
      accessibilityRole="button"
      accessibilityLabel={hudCopy.sos.call911}
      accessibilityHint={hudCopy.sos.call911Hint}
      onPress={() => call(EMERGENCY_NUMBER)}
      style={({ pressed }) => [styles.call, { backgroundColor: red, opacity: pressed ? 0.8 : 1 }]}
    >
      <Ionicons name="call" size={26} color={CALL_INK} />
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} style={[styles.callLabel, { color: CALL_INK }]}>
        {hudCopy.sos.call911}
      </Text>
    </Pressable>
  );
  const rest = (
    <>
      {failed ? (
        <Text testID="hud-sos-failed" accessibilityRole="alert" style={[styles.line, { color: c.ink }]}>
          {hudCopy.sos.failed}
        </Text>
      ) : null}
      {contacts === undefined ? null : contacts.length === 0 ? (
        <Text testID="hud-sos-none" style={[styles.line, { color: c.muted }]}>
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
              style={({ pressed }) => [styles.row, { borderColor: c.edge, opacity: pressed ? 0.7 : 1 }]}
            >
              <Ionicons name="call-outline" size={24} color={c.ink} />
              <View style={styles.rowText}>
                <Text numberOfLines={1} style={[styles.name, { color: c.ink }]}>
                  {contact.name}
                </Text>
                <Text numberOfLines={1} style={[styles.number, { color: c.muted }]}>
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
      style={({ pressed }) => [styles.close, { borderColor: c.edge, opacity: pressed ? 0.7 : 1 }]}
    >
      <Text style={[styles.closeLabel, { color: c.ink }]}>{hudCopy.sos.close}</Text>
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
      <Text accessibilityRole="header" style={[styles.title, { color: c.ink }]}>
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
  title: { fontFamily: fontFamilies.headline, fontSize: 22, lineHeight: 28 },
  list: { flexGrow: 0, flexShrink: 1 },
  listBody: { gap: 8 },
  call: {
    minHeight: SOS_CALL_H_PT,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 14,
    paddingHorizontal: 12,
  },
  callLabel: { flexShrink: 1, fontFamily: fontFamilies.headline, fontSize: 22 },
  line: { fontFamily: fontFamilies.ui, fontSize: 16, lineHeight: 22 },
  row: {
    minHeight: HUD_MIN_TARGET_PT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 14,
    borderWidth: 1,
  },
  rowText: { flex: 1 },
  name: { fontFamily: fontFamilies.headline, fontSize: 19, lineHeight: 24 },
  number: { fontFamily: fontFamilies.ui, fontSize: 15, lineHeight: 20 },
  close: { minHeight: 56, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1 },
  closeLabel: { fontFamily: fontFamilies.headline, fontSize: 18 },
});

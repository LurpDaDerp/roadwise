import type { ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { EmergencyContact } from '@/features/emergency/model';
import { useEmergencyContacts } from '@/features/emergency/useEmergencyContacts';
import { reportError } from '@/lib/crashReport';
import { HUD_MIN_TARGET_PT, hudPalette } from '@/ui/drive';
import { fontFamilies } from '@/ui/fonts';
import { useOptionalTheme } from '@/ui/theme';

import { EmergencyButton } from './EmergencyButton';
import { EmergencyPanel } from './EmergencyPanel';
import { placeCall } from './emergencyCall';
import { hudButtonColors } from './hudButtons';
import { hudCopy } from './hudCopy';
import type { WaitPanelColors } from './WaitPanel';

/** The Try again target: the HUD's 64 pt height, and wide enough to hit without looking. */
export const HUD_CRASHED_TARGET_W_PT = 240;

/**
 * The driving screen's error boundary (Expo Router's `ErrorBoundary` export of `app/drive/_layout`):
 * the driving screen threw while drawing. Only the screen is lost: the drive itself records in the
 * drive host, outside React, so it neither ends nor is discarded here, and the root's drive hold
 * (`LockoutGate`) still keeps the screen awake, swallows Android back and holds the app on this
 * route. In-car rules: three words and two, one 64 pt target, nothing moves. The one action is
 * Try again, which draws the driving screen again; there is no way Home from here, because the
 * hold would send a moving driver straight back. The error goes to the crash sink once.
 *
 * The emergency button stays too, at the top left, on the plain HUD colours: a tap opens the
 * emergency panel in place of the words ("Call 911", the driver's contacts, Close). The contacts are
 * read in a guard of their own, so a failure there still leaves "Call 911".
 */
export function HudCrashed({ error, retry }: ErrorBoundaryProps) {
  const night = useOptionalTheme()?.hudNight ?? false;
  const p = hudPalette(night);
  const b = hudButtonColors(null, p, night);
  const sheet: WaitPanelColors = { surface: p.chrome, ink: p.ink, muted: p.inkMuted, edge: p.chromeEdge };
  const [sosOpen, setSosOpen] = useState(false);
  const [sheetSize, setSheetSize] = useState({ w: 0, h: 0 });
  const closeSos = useCallback(() => setSosOpen(false), []);
  const callSos = useCallback(async (phone: string) => {
    const ok = await placeCall(phone);
    if (ok) setSosOpen(false);
    return ok;
  }, []);
  useEffect(() => {
    reportError(error, 'driving screen');
  }, [error]);
  const panel = (contacts: readonly EmergencyContact[] | undefined) => (
    <EmergencyPanel contacts={contacts} palette={p} colors={sheet} height={sheetSize.h} width={sheetSize.w} onCall={callSos} onClose={closeSos} />
  );
  return (
    <SafeAreaView style={[styles.ground, { backgroundColor: p.ground }]} testID="hud-crashed">
      <StatusBar style="light" />
      <View style={styles.top}>
        <EmergencyButton palette={p} colors={b} open={sosOpen} onPress={() => setSosOpen(true)} />
      </View>
      {sosOpen ? (
        <View
          testID="hud-crashed-sos-sheet"
          onLayout={(e) => setSheetSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
          style={[styles.sheet, { backgroundColor: sheet.surface, borderColor: sheet.edge }]}
        >
          <ContactsGuard fallback={panel(undefined)}>
            <CrashContacts render={panel} />
          </ContactsGuard>
        </View>
      ) : (
        <View style={styles.middle}>
          <View style={styles.body} accessible accessibilityLabel={hudCopy.crashed.spoken}>
            <Text style={[styles.title, { color: p.ink }]} accessibilityRole="header" maxFontSizeMultiplier={1.5}>
              {hudCopy.crashed.title}
            </Text>
          </View>
          <Pressable
            testID="hud-crashed-retry"
            accessibilityRole="button"
            accessibilityLabel={hudCopy.crashed.retry}
            accessibilityHint={hudCopy.crashed.retryHint}
            onPress={() => void retry()}
            style={[styles.button, { backgroundColor: p.chrome, borderColor: p.chromeEdge }]}
          >
            <Text style={[styles.label, { color: p.ink }]} maxFontSizeMultiplier={1.5}>
              {hudCopy.crashed.retry}
            </Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}

/** The saved contacts for the crash screen's panel. */
function CrashContacts({ render }: { render(contacts: readonly EmergencyContact[] | undefined): ReactNode }) {
  const { contacts } = useEmergencyContacts();
  return render(contacts);
}

/** Shows `fallback` (the panel with "Call 911" and no contacts) if reading the contacts throws. */
class ContactsGuard extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const styles = StyleSheet.create({
  ground: { flex: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16 },
  top: { flexDirection: 'row', alignItems: 'center', height: HUD_MIN_TARGET_PT },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 8, gap: 32 },
  sheet: { flex: 1, marginTop: 12, borderRadius: 20, borderWidth: 1, padding: 16 },
  body: { alignItems: 'center' },
  title: { fontFamily: fontFamilies.headline, fontSize: 34, lineHeight: 40, textAlign: 'center' },
  button: {
    minHeight: HUD_MIN_TARGET_PT,
    minWidth: HUD_CRASHED_TARGET_W_PT,
    paddingHorizontal: 32,
    borderRadius: 999,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontFamily: fontFamilies.label, fontSize: 26, lineHeight: 32 },
});

// The look the driving screen's panels share (the list of navigation apps, "Where to?", the
// waiting panels and the emergency panel), and the list of apps in its Settings sheet: rows are
// soft filled tiles with the icon in a round accent badge, the buttons are capsules as elsewhere in
// the app, and a press sinks a touch. Only looks live here; every size floor stays the callers'.
import { StyleSheet, type ViewStyle } from 'react-native';

import { mix } from '../sky/color';
import { fontFamilies } from '../fonts';

/** The colours a panel is drawn in: the app's sheet set (or the HUD's own outside a theme). */
export interface PanelColors {
  surface: string;
  ink: string;
  muted: string;
  edge: string;
  /** A row's fill (the theme's raised surface). Default: the surface a step toward the ink. */
  raised?: string;
  /** Icons and the chosen row's mark (the sky's accent). Default: the ink. */
  accent?: string;
  /** The icon badge's wash. Default: the surface a little further toward the ink. */
  accentFaint?: string;
}

export type PanelTones = Required<PanelColors>;

export function panelTones(c: PanelColors): PanelTones {
  return {
    ...c,
    raised: c.raised ?? mix(c.surface, c.ink, 0.07),
    accent: c.accent ?? c.ink,
    accentFaint: c.accentFaint ?? mix(c.surface, c.ink, 0.12),
  };
}

/** A pressed tile or capsule sinks a little and lightens. */
export const pressedLook = (pressed: boolean): ViewStyle => ({ opacity: pressed ? 0.86 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] });

export const PANEL_BADGE_PT = 40;
export const PANEL_ICON_PT = 22;
export const PANEL_CAPSULE_PT = 56;

export const panelStyles = StyleSheet.create({
  header: { gap: 4 },
  title: { fontFamily: fontFamilies.headline, fontSize: 22, lineHeight: 28 },
  line: { fontFamily: fontFamilies.ui, fontSize: 16, lineHeight: 22 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 12,
    paddingRight: 14,
    paddingVertical: 10,
    borderRadius: 20,
    borderCurve: 'continuous',
    borderWidth: 1.5,
  },
  badge: {
    width: PANEL_BADGE_PT,
    height: PANEL_BADGE_PT,
    borderRadius: PANEL_BADGE_PT / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontFamily: fontFamilies.headline, fontSize: 18, lineHeight: 23 },
  rowSub: { fontFamily: fontFamilies.ui, fontSize: 14, lineHeight: 19 },
  capsule: {
    minHeight: PANEL_CAPSULE_PT,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 20,
    borderRadius: PANEL_CAPSULE_PT / 2,
    borderCurve: 'continuous',
    borderWidth: 1,
  },
  capsuleLabel: { fontFamily: fontFamilies.headline, fontSize: 17 },
});

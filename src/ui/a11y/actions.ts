import { Platform, type AccessibilityActionInfo } from 'react-native';

/**
 * The screen-reader actions of a pressable that also carries actions of its own (a card's ✕ as
 * "dismiss", say): on Android `activate` first, then `actions`; on iOS only `actions`.
 *
 * TalkBack's double-tap arrives as the `activate` action, so Android lists it (handle it in
 * `onAccessibilityAction`). On iOS a VoiceOver double-tap never comes as an action: it reaches
 * `onPress` (or `onAccessibilityTap`) on its own, and every listed action shows in VoiceOver's
 * Actions rotor by its label, or by its raw name when it has none, so an `activate` there would be
 * read out as the word "activate".
 */
export function withActivate(...actions: AccessibilityActionInfo[]): AccessibilityActionInfo[] {
  return Platform.OS === 'android' ? [{ name: 'activate' }, ...actions] : actions;
}

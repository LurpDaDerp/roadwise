import { useEffect } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

export type AnnounceOptions = {
  /**
   * Say it on iOS only: for a line Android already reads by itself, such as text that changes
   * inside a view that stays on screen with `accessibilityLiveRegion`, so TalkBack never says it twice.
   */
  iosOnly?: boolean;
};

/**
 * Reads a line out to the screen reader once each time it appears or changes: an error or status
 * line that shows up after an action, away from the button the reader is on.
 *
 * Neither `accessibilityRole="alert"` nor `accessibilityLiveRegion` makes VoiceOver speak on its
 * own (iOS has no alert trait, and live regions are Android only), so this asks the reader directly.
 * On iOS the line waits for whatever VoiceOver is saying (the button's own "dimmed" or busy state)
 * instead of cutting it off and being cut off in turn.
 *
 * `null`, `undefined` or `''` says nothing. The same words again after a `null` are said again, so a
 * second failed attempt that clears its error first is heard like the first. Re-renders with the
 * same words say nothing more.
 */
export function useAnnounce(text: string | null | undefined, { iosOnly = false }: AnnounceOptions = {}): void {
  useEffect(() => {
    if (!text) return;
    if (Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibilityWithOptions?.(text, { queue: true });
    } else if (!iosOnly) {
      AccessibilityInfo.announceForAccessibility?.(text);
    }
    // Once per line: a change of `iosOnly` alone is not a new line to say.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
}

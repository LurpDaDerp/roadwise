import { useEffect, useRef, useState, type RefObject } from 'react';
import { Keyboard, Platform, type View } from 'react-native';

import { windowTopOnScreen } from './systemBars';

/**
 * How far the bottom of a view sits under the Android keyboard, in points; 0 while it is down, and
 * always 0 on iPhone.
 *
 * Why Android needs it: RoadWise draws edge to edge (enforced from Android 15, on in every release
 * here), and an edge-to-edge window is not resized for the keyboard (`adjustResize` stops moving
 * anything once the app takes the insets itself). The iPhone's answers are iOS-only props
 * (`automaticallyAdjustKeyboardInsets`, the keyboard avoider's `padding` with no Android behaviour
 * set), so a field near the foot of a screen would stay under the keyboard.
 *
 * The owner pads its bottom by the lift, so its scroll view's window ends at the keyboard's top
 * edge; Android's `ScrollView` then keeps the focused field in sight as its window shrinks. The lift
 * is measured, not assumed: on each keyboard change the view's frame in the window is compared
 * with the keyboard's top (React Native's `keyboardDidShow`, from the window's IME insets), so it
 * is right under a tab bar, a top bar or a sheet alike, and comes out 0 wherever the system did
 * resize the window. The keyboard's top arrives in screen coordinates and the frame in window
 * coordinates, so the window's own top on the screen (`windowTopOnScreen`: 0 full screen, the
 * offset of a split-screen pane or a freeform / desktop window) is taken off the keyboard's top
 * first. Event-driven: nothing listens or measures on iPhone, and nothing runs between keyboard
 * changes.
 */
export function useKeyboardLift(ref: RefObject<View | null>): number {
  const [lift, setLift] = useState(0);
  // The latest keyboard top a measure was started for, so a stale measure never lands.
  const seq = useRef(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let alive = true;
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      const keyboardTop = e.endCoordinates.screenY;
      const mine = ++seq.current;
      void windowTopOnScreen().then((windowTop) => {
        if (!alive || mine !== seq.current) return;
        const view = ref.current;
        if (!view || typeof view.measureInWindow !== 'function') return;
        view.measureInWindow((_x, y, _w, h) => {
          if (!alive || mine !== seq.current) return;
          setLift(keyboardLift(y + h, keyboardTop, windowTop));
        });
      });
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      seq.current++;
      setLift(0);
    });
    return () => {
      alive = false;
      show.remove();
      hide.remove();
    };
  }, [ref]);
  return lift;
}

/**
 * The overlap between a view whose bottom is at `viewBottom` (window points) and a keyboard whose
 * top is at `keyboardTop` (screen points), in a window whose top is `windowTop` points down the
 * screen.
 */
export function keyboardLift(viewBottom: number, keyboardTop: number, windowTop = 0): number {
  if (!Number.isFinite(viewBottom) || !Number.isFinite(keyboardTop)) return 0;
  const top = Number.isFinite(windowTop) ? windowTop : 0;
  return Math.max(0, Math.round(viewBottom - (keyboardTop - top)));
}

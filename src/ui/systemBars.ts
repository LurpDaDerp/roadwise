import { requireOptionalNativeModule } from 'expo-modules-core';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

/**
 * The Android navigation bar's button ink, the bottom-edge partner of the status bar's style.
 *
 * Android only. RoadWise draws edge to edge, so the navigation bar (three buttons, or the gesture
 * handle) sits over the app's own page; left alone, its buttons follow the phone's Light / Dark
 * setting, not the page under them. Like `expo-status-bar`'s `StatusBar`, each screen that owns the
 * foot of the window says which ink reads there, and the last one mounted wins:
 * - the root (`SkyChrome`): the theme's scheme, since the foot of every screen is the page ground
 *   or the floating tab bar on it (light buttons on a dark page, dark on a light one);
 * - the driving screen and Wrapped's story: light, over their true black and dark gradients.
 * The sky's painted band never reaches the bottom, so it plays no part here.
 *
 * iPhone has no navigation bar: nothing is loaded and nothing is called. A build without the native
 * half (`RoadWiseSystemBars` in drive-sense's Android module) leaves the phone's ink, as before.
 */
export type BarInk = 'light' | 'dark';

interface SystemBarsModule {
  setNavigationBarInk(ink: BarInk): Promise<void>;
  windowTopOnScreen?(): Promise<number>;
}

let native: SystemBarsModule | null | undefined;

function bars(): SystemBarsModule | null {
  if (Platform.OS !== 'android') return null;
  if (native === undefined) {
    try {
      native = requireOptionalNativeModule<SystemBarsModule>('RoadWiseSystemBars');
    } catch {
      native = null;
    }
  }
  return native;
}

/** The mounted requests, oldest first; the last one is the ink on screen. */
const stack: { id: number; ink: BarInk }[] = [];
let nextId = 1;
let shown: BarInk | null = null;

function show(): void {
  const top = stack[stack.length - 1];
  if (!top || top.ink === shown) return;
  const module = bars();
  if (!module) return;
  shown = top.ink;
  void module.setNavigationBarInk(top.ink).catch(() => {
    // Refused (no activity yet): asked again by the next change; the module re-applies on resume.
    shown = null;
  });
}

/**
 * Holds the navigation bar's buttons at `ink` while the calling screen is mounted; on unmount the
 * screen mounted before it takes over. A change of `ink` while another screen is on top is kept
 * for when it is uncovered.
 */
export function useNavigationBarInk(ink: BarInk): void {
  const id = useRef(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    id.current = nextId++;
    stack.push({ id: id.current, ink });
    show();
    return () => {
      const at = stack.findIndex((e) => e.id === id.current);
      if (at >= 0) stack.splice(at, 1);
      show();
    };
    // Mount and unmount only: a change of ink updates the entry in place (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const entry = stack.find((e) => e.id === id.current);
    if (!entry || entry.ink === ink) return;
    entry.ink = ink;
    show();
  }, [ink]);
}

/**
 * The top of RoadWise's window on the screen, in points, for the keyboard lift (`./keyboard`):
 * React Native gives the keyboard's top in screen coordinates and a view's frame in the window's.
 * 0 full screen on a phone; the pane's or window's offset in split screen and freeform / desktop
 * windows. 0 (the full-screen answer) on iPhone, on a build without the native half, or if the
 * call fails. One native call per keyboard change.
 */
export async function windowTopOnScreen(): Promise<number> {
  const module = bars();
  if (!module || typeof module.windowTopOnScreen !== 'function') return 0;
  try {
    const top = await module.windowTopOnScreen();
    return typeof top === 'number' && Number.isFinite(top) ? top : 0;
  } catch {
    return 0;
  }
}

/** Tests only: forget every request and the native lookup. */
export function resetNavigationBarInkForTests(): void {
  stack.length = 0;
  nextId = 1;
  shown = null;
  native = undefined;
}

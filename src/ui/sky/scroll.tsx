// The sky scrolls with its screen.
//
// The painted band is drawn once, behind every tab, but each tab's content scrolls over it. Left
// fixed, the band's saturated stops would sit behind whatever scrolled up into them: section headers,
// links and notes drawn in the page ink, which read on the page ground and not on the sky. So the
// band follows the tab in front: it moves up exactly as far as that tab's content has scrolled, and
// what sat below the fade at rest stays below it. The status bar keeps a fixed strip of the sky's top.
//
// - `SkyScrollProvider` (the tabs shell) owns the shared offset and is told which tab is in front.
// - `SkyScrollScope name` wraps a tab's route, so the scroll views inside it know whose they are.
// - `useSkyScrollHandler()` is the scroll handler for a tab's main scroll view (an Animated one).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useAnimatedScrollHandler, useSharedValue, type SharedValue } from 'react-native-reanimated';

type SkyScroll = {
  /** How far the tab in front has scrolled, in points. */
  offset: SharedValue<number>;
  /** The tab in front. */
  active: SharedValue<string>;
  register: (name: string, offset: SharedValue<number>) => () => void;
  focus: (name: string) => void;
};

const Link = createContext<SkyScroll | null>(null);
const Scope = createContext<string | null>(null);

export function SkyScrollProvider({ children }: { children: ReactNode }) {
  const offset = useSharedValue(0);
  const active = useSharedValue('');
  const screens = useRef(new Map<string, SharedValue<number>>());
  const register = useCallback((name: string, own: SharedValue<number>) => {
    screens.current.set(name, own);
    return () => {
      if (screens.current.get(name) === own) screens.current.delete(name);
    };
  }, []);
  const focus = useCallback(
    (name: string) => {
      active.set(name);
      offset.set(screens.current.get(name)?.get() ?? 0);
    },
    [active, offset]
  );
  const value = useMemo(() => ({ offset, active, register, focus }), [offset, active, register, focus]);
  return <Link.Provider value={value}>{children}</Link.Provider>;
}

/** Marks a tab's route: the scroll view inside it moves the sky while this tab is in front. */
export function SkyScrollScope({ name, children }: { name: string; children: ReactNode }) {
  return <Scope.Provider value={name}>{children}</Scope.Provider>;
}

/** The shared offset the backdrop follows; null outside the tabs shell (a preview, a test). */
export function useSkyOffset(): SharedValue<number> | null {
  return useContext(Link)?.offset ?? null;
}

/** Tells the sky which tab is now in front (the tabs shell calls it on every tab focus). */
export function useSkyFocus(): (name: string) => void {
  const link = useContext(Link);
  return useCallback((name: string) => link?.focus(name), [link]);
}

/**
 * The scroll handler for a tab's main scroll view (pass it to an `Animated.ScrollView`'s
 * `onScroll`, with `scrollEventThrottle={16}`). It remembers this tab's offset and, while the tab
 * is in front, moves the sky by it. Outside a scope or the shell it only remembers.
 */
export function useSkyScrollHandler() {
  const link = useContext(Link);
  const name = useContext(Scope);
  const own = useSharedValue(0);
  const fallback = useSharedValue(0);
  const nobody = useSharedValue('');
  const offset = link?.offset ?? fallback;
  const active = link?.active ?? nobody;
  const key = name ?? '';
  useEffect(() => (link && name ? link.register(name, own) : undefined), [link, name, own]);
  return useAnimatedScrollHandler(
    {
      onScroll: (e) => {
        own.set(e.contentOffset.y);
        if (key !== '' && active.get() === key) offset.set(e.contentOffset.y);
      },
    },
    [key]
  );
}

import { Redirect } from 'expo-router';
import type { ComponentType } from 'react';

/**
 * `/(app)/dev/ui`: the design-system gallery (every primitive, light and dark, reduce motion on/off).
 * Development and `EXPO_PUBLIC_DIAGNOSTICS=1` builds only; anything else is sent home.
 *
 * The gallery is reached through the guarded `require` below, never an import: a release build
 * inlines the flag and `__DEV__`, Metro folds the condition to `false`, and the gallery is not
 * bundled. Keep the condition spelled out literally in the ternary so it folds.
 */
export default function UiGalleryPage() {
  const Gallery =
    process.env.EXPO_PUBLIC_DIAGNOSTICS === '1' || __DEV__
      ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- a static import would bundle it in every build
        (require('@/ui/gallery/UiGallery') as { UiGallery: ComponentType }).UiGallery
      : null;
  if (Gallery === null) return <Redirect href="/" />;
  return <Gallery />;
}

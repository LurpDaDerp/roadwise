// The Android share sheet with an image (WP09): `shareImage` of the Kotlin DriveSense module
// (ShareIntent.kt). React Native's `Share` carries text only on Android and expo-sharing carries no
// text, so a Wrapped (image plus line and link) and a drive's card (with Save image) go through this.
// iPhone keeps its own sheet: `shareImage` is not in DRIVE_SENSE_METHODS and the iOS module has none.
import { requireOptionalNativeModule } from 'expo-modules-core';

/** The Android-only share function of the DriveSense module (`AsyncFunction` in DriveSenseModule.kt). */
export const ANDROID_SHARE_METHODS = ['shareImage'] as const;

/** What the sheet shows with the image. */
export interface ShareImageOptions {
  /** Text beside the image (a Wrapped's line and link); none for a drive's card. */
  text?: string | null;
  /** The sheet's title ("Share your drive"); the system's own when absent. */
  title?: string | null;
}

/** The native share, when this build has it (an Android build with WP09); null elsewhere. */
export type ShareImage = (uri: string, options?: ShareImageOptions) => Promise<boolean>;

type ShareModule = { shareImage?: (uri: string, text: string | null, title: string | null) => Promise<unknown> };

let moduleForTests: ShareModule | null | undefined;

/** Tests: stand in for the native module (null: none); undefined goes back to the real lookup. */
export function setShareModuleForTests(m: ShareModule | null | undefined): void {
  moduleForTests = m;
}

const lookup = (): ShareModule | null => (moduleForTests !== undefined ? moduleForTests : (requireOptionalNativeModule<ShareModule>('DriveSense') ?? null));

/** The longest text handed to the sheet (a Wrapped's line and link is far shorter). */
const MAX_TEXT = 1000;

/**
 * Opens the system share sheet with the image at `uri` (a capture in RoadWise's cache), with Save
 * image on Android 10+. Resolves true once the sheet is up, false when it could not open (no
 * activity on screen, a file that is not a share image). Rejects only when the call itself fails.
 * Null where the build has no native share: the caller keeps its own path.
 */
export function nativeShareImage(): ShareImage | null {
  const m = lookup();
  if (!m || typeof m.shareImage !== 'function') return null;
  const fn = m.shareImage.bind(m);
  return async (uri, options = {}) => {
    if (typeof uri !== 'string' || uri.length === 0) return false;
    const text = typeof options.text === 'string' && options.text.length > 0 ? options.text.slice(0, MAX_TEXT) : null;
    const title = typeof options.title === 'string' && options.title.length > 0 ? options.title : null;
    return (await fn(uri, text, title)) === true;
  };
}

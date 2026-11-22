// Android's FLAG_SECURE on React Native's Modal dialogs: `secureDialogs` of the Kotlin DriveSense
// module (SecureDialogs.kt). expo-screen-capture secures the activity's window only, and a Modal on
// Android is a separate dialog window that copies the flag once, when it is created, so the DashPal
// sheets that show the aiming picture would be left out of the protection. iPhone needs none of it
// (expo-screen-capture's protection covers the whole key window, Modals included): this is not in
// DRIVE_SENSE_METHODS and the iOS module has none.
import { requireOptionalNativeModule } from 'expo-modules-core';

/** The Android-only dialog function of the DriveSense module (`AsyncFunction` in DriveSenseModule.kt). */
export const ANDROID_SECURE_DIALOG_METHODS = ['secureDialogs'] as const;

type SecureDialogsModule = {
  secureDialogs?: (key: string, on: boolean) => Promise<unknown>;
};

let moduleForTests: SecureDialogsModule | null | undefined;

/** Tests: stand in for the native module (null: none); undefined goes back to the real lookup. */
export function setSecureDialogsModuleForTests(m: SecureDialogsModule | null | undefined): void {
  moduleForTests = m;
}

const lookup = (): SecureDialogsModule | null =>
  moduleForTests !== undefined ? moduleForTests : (requireOptionalNativeModule<SecureDialogsModule>('DriveSense') ?? null);

/**
 * A screen showing the aiming picture holds (`on` true) or lets go of (false) FLAG_SECURE on every
 * Modal dialog, under its own `key`: the flag stays while any key is held, a dialog opened meanwhile
 * included. Nothing where the build has no such function (iOS, Jest, an Android build made before
 * it). Never rejects.
 */
export async function secureDialogs(key: string, on: boolean): Promise<void> {
  const m = lookup();
  if (!m || typeof m.secureDialogs !== 'function') return;
  try {
    await m.secureDialogs(key, on);
  } catch {
    // Nothing to do: the activity's own flag still keeps the app behind the sheet out of captures.
  }
}

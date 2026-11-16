// Android's "Pause app activity if unused" (ruling 15): `getUnusedAppRestrictions` and
// `openUnusedAppRestrictionsSettings` of the Kotlin DriveSense module (UnusedAppRestrictions.kt).
// iPhone has no such switch: neither is in DRIVE_SENSE_METHODS and the iOS module has none. The app
// reaches them through the permission port (src/core/permissions/driveSensePort.ts), which
// feature-detects each one on the native module, so an older Android build simply lists no row.

/** The Android-only functions of the DriveSense module for the unused-app switch (`AsyncFunction` in DriveSenseModule.kt). */
export const ANDROID_UNUSED_APP_METHODS = ['getUnusedAppRestrictions', 'openUnusedAppRestrictionsSettings'] as const;

// The DMS public surface (plan "Bridge API", Task 14): what M7 imports. The engine, the policy and the
// replay tooling stay internal; see README.md here for the contract.
export {
  createDmsController,
  type DmsController,
  type DmsControllerDeps,
  type DmsGateInputs,
  type DmsHostPower,
  type DmsHostSummary,
  type DmsHudStatus,
  type DmsSeedResult,
  type DmsSetupCheck,
  type DmsHostDiagnostics,
  type DmsNativeView,
  type DmsNativeOwner,
} from './host/controller';
// M7 builds its controller here: the real native module is bound inside the host (security T14 m-1).
export { createDefaultDmsController, createDefaultShadowComparator, type DmsDefaultControllerDeps } from './host/default';
// The dev panel's shadow comparison (both gaze sources, counts and aggregates only). Not for M7.
export type { DmsShadowComparator, DmsShadowOptions, DmsShadowStats, DmsShadowSourceStats } from './host/shadow';
export { createSettingsProfileStore, DMS_PROFILE_KEY, type DmsProfileStore, type SettingsLike } from './host/profileStore';
export { createFocusQueue } from './adapters/focus';
export type { AlertKind, DmsAlertCommand } from './engine/alerts';
export type { DmsEvent } from './engine/engine';
export type { DmsTripSummary } from './engine/summary';
export type { DmsConfigOverrides } from './engine/config';

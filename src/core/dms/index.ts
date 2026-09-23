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
export { createDefaultDmsController, type DmsDefaultControllerDeps } from './host/default';
export { createSettingsProfileStore, DMS_PROFILE_KEY, type DmsProfileStore, type SettingsLike } from './host/profileStore';
export { createFocusQueue } from './adapters/focus';
export type { AlertKind, DmsAlertCommand } from './engine/alerts';
export type { DmsEvent } from './engine/engine';
export type { DmsTripSummary } from './engine/summary';
export type { DmsConfigOverrides } from './engine/config';

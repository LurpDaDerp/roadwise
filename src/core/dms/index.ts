// The DMS public surface: what the camera bridge (src/features/camera), the focus detector
// (src/core/detectors/focus.ts) and the drive engine's finalize import. The engine, the policy and the
// replay tooling stay internal; see README.md here for the contract.
export {
  createDmsController,
  type DmsController,
  type DmsControllerDeps,
  type DmsGateInputs,
  type DmsHostPower,
  type DmsHostSummary,
  type DmsHudStatus,
  type DmsPresence,
  type DmsSeedResult,
  type DmsSetupCheck,
  type DmsSetupGaze,
  type DmsHostDiagnostics,
  type DmsNativeView,
  type DmsNativeOwner,
} from './host/controller';
// The bridge builds its controller here: the real native module is bound inside the host (security T14 m-1).
export { createDefaultDmsController, type DmsDefaultControllerDeps } from './host/default';
export { createSettingsProfileStore, createSettingsSetupStore, DMS_PROFILE_KEY, DMS_SETUP_KEY, type DmsProfileStore, type DmsSetupStore, type SettingsLike } from './host/profileStore';
// The setup session (the 20-second mount and gaze calibration) and its pure step machine.
export { createDmsSetupSession, SETUP_TICK_MS, setupRow, type DmsSetupSession, type DmsSetupSessionDeps, type DmsSetupView, type SetupResult } from './host/setup';
export {
  initialSetup,
  issueOf,
  MIRROR_MS,
  MIRROR_PROMPTS,
  MOUNT_HOLD_MS,
  ROAD_MS,
  SETUP_MAX_MS,
  SETUP_STEPS,
  setupProgress,
  stepSetup,
  type MirrorPrompt,
  type SetupFailure,
  type SetupInput,
  type SetupIssue,
  type SetupState,
  type SetupStep,
} from './host/setupMachine';
// The native setup preview (blank outside the parked setup).
export { previewView } from './host/preview';
// The scoring seams: the focus samples the detector consumes, and the payload's DMS flags.
export { createFocusQueue, type DmsFocusSample } from './adapters/focus';
export { DMS_FACE_SEEN_MIN_SHARE, DMS_ON_MIN_FACE_SHARE, dmsPayloadFlags, faceShare, type DmsFlagInputs } from './adapters/flags';
export type { AlertKind, DmsAlertCommand } from './engine/alerts';
export type { DmsEvent } from './engine/engine';
export type { DmsTripSummary } from './engine/summary';
export type { DmsConfigOverrides } from './engine/config';
export type { DmsSetupRecord } from './engine/setupRecord';

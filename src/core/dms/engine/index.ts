// The DMS engine's public surface (plan Task 12): the façade, its config and the types the host (Task 14)
// and the alert player (M7) need. Everything else in this folder is internal.
export { createDmsEngine, type DmsEngine, type DmsEngineInit, type DmsEvent, type DmsHostState, type DmsOutput, type DmsSizes, type DmsSnapshot } from './engine';
export { DEFAULT_DMS_CONFIG, configFromJson, resolveDmsConfig, validateDmsConfig, type DmsConfig, type DmsConfigOverrides } from './config';
export type { AlertKind, DmsAlertCommand } from './alerts';
export type { DmsTripSummary } from './summary';
export type { CalibrationState, SeedResult } from './calibration';
export type { DmsProfileV1 } from './profile';
export { parseProfile } from './profile';
export type { FeatureRowLike, RowExtras } from './context';
export type { EngineFrame } from './types';

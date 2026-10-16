export { runFix, type FixDeps, type FixOutcome } from './actions';
export { boardRows, fixFor, homeCard, overall, readPermissionBoard, settingsRows, type BoardRow, type Fix, type HomeCard, type Overall, type SettingsRow } from './board';
export { homeLine, permissionName, permissionsCopy, requestLabel, rowDetail, rowTitle, statusWord, type CopyCtx } from './copy';
export { HealthRow } from './HealthRow';
export { EMPTY_HOME_PREFS, hideOnHome, readHomePrefs, showOnHome, type HomePrefs } from './homePrefs';
export { PermissionsScreen } from './PermissionsScreen';
export { PERMISSIONS, permissionDef, signature, type MissingState, type PermissionBoardRead, type PermissionDef, type PermissionId, type PermState } from './registry';
export { homePrefsKey, permissionBoardKey, usePermissionBoard, watchDashcamPermissions, type PermissionBoard, type PermissionBoardDeps, type RefreshMode } from './usePermissionBoard';
export {
  defaultPermissionsAdapter,
  markSettingsReturn,
  permissionHealthKey,
  readPermissionHealth,
  SETTINGS_RETURN_ACK_KEY,
  SETTINGS_RETURN_ACK_MS,
  SHARED_READ_MS,
  sharedPermissionSnapshot,
  takeSettingsReturnAck,
} from './usePermissionHealth';

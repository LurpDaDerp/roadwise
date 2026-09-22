export { permissionsCopy, rowConsequence, rowStatus, rowTitle, type ConsequenceContext } from './copy';
export { guideFor, vendorOf } from './oemGuides';
export {
  completedDrives,
  defaultPermissionsAdapter,
  flushPendingDisclosureConsent,
  markSettingsReturn,
  PENDING_DISCLOSURE_CONSENT_KEY,
  recordDisclosureConsent,
  SETTINGS_RETURN_ACK_KEY,
  SETTINGS_RETURN_ACK_MS,
  takeSettingsReturnAck,
  usePermissionHealth,
  type PermissionHealth,
  type PermissionHealthDeps,
  type RecordDisclosureConsent,
} from './usePermissionHealth';
export { FIX_LABEL, fixFor, HealthRow, type FixTarget } from './HealthRow';
export {
  PermissionHealthScreen,
  readinessMessage,
  REPAIR_HREF,
  type PermissionHealthScreenDeps,
} from './PermissionHealthScreen';
export {
  BackgroundDisclosure,
  DISCLOSURE_REASONS,
  parseDisclosureReason,
  type BackgroundDisclosureDeps,
  type DisclosureReason,
  type DisclosureResult,
} from './BackgroundDisclosure';
export { bannerMessage, PERMISSIONS_HREF, PermissionHealthBanner } from './PermissionHealthBanner';
export {
  offerDue,
  offerHref,
  PermissionPromptsHost,
  type AlwaysOffer,
  type AlwaysOffers,
  type OfferInput,
  type PermissionPromptsHostDeps,
} from './PermissionPromptsHost';

// The DashPal settings keys (SQLite `settings`; every one starts with `dashcam.`, which the handover
// wipe keeps: the pairing belongs to the phone) and the SecureStore flag the transport reads at
// module load, before SQLite is open (the other SecureStore entries: `secure.ts`).
import { isDashcamId } from './protocol';

export const PAIRED_KEY = 'dashcam.paired';
export const BUZZER_TOO_KEY = 'dashcam.buzzerToo';
/** The driver asked for DashPal at least once: the auto-detect prompt may scan (never prompts for permission). */
export const BT_OPT_IN_KEY = 'dashcam.btOptIn';
/** `{ [dashcamId]: snoozedUntilMs }`: "Not now" on the auto prompt, 7 days per dashcam. */
export const SNOOZES_KEY = 'dashcam.snoozes';
/**
 * The new-phone notice (`newPhone.ts`): `{ dashcamId, count, ownUntil, notice }`, the last phone
 * count a verified STATUS or PAIRED reported, the end of this phone's own Add another phone, and
 * the notice waiting to be dismissed. A `dashcam.` key: it survives the account handover with the
 * pairing.
 */
export const LAST_PHONES_KEY = 'dashcam.lastPhones';
/**
 * The paired DashPal says its camera needs re-aiming (STATUS bit 7: its aim watch, kept by the
 * dashcam across power cycles): `{ dashcamId }`, kept here so Home can remind with the DashPal off;
 * removed when a STATUS without the bit arrives, on forget, and when another DashPal is paired.
 */
export const REAIM_KEY = 'dashcam.reaim';

/** A stored re-aim record's DashPal, or null. */
export function asReaim(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const id = (value as Record<string, unknown>).dashcamId;
  return isDashcamId(id) ? id : null;
}

/** SecureStore: start the BLE manager at launch (written at opt-in and pairing; survives wipes). */
export const ENABLED_SECURE_KEY = 'dashpal.enabled';

export interface PairedDashcam {
  /** lowercase hex identity MAC (12 chars) */
  dashcamId: string;
  /** the OS peripheral id: the CBPeripheral UUID on iOS, the MAC on Android */
  peripheralId: string;
  /** `DashPal-XXXX` */
  name: string;
  /** epoch ms */
  pairedAt: number;
  /** a link v2 pairing (its key is `dashpal.auth` in SecureStore) */
  secure: true;
}

/**
 * A stored value as a paired record, or null when it is not one. A record without `secure: true`
 * is a link v1 pairing (Bluetooth bonding), which no DashPal speaks any more: not a pairing.
 */
export function asPaired(value: unknown): PairedDashcam | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!isDashcamId(v.dashcamId) || typeof v.peripheralId !== 'string' || v.peripheralId.length === 0 || v.secure !== true) return null;
  return {
    dashcamId: v.dashcamId,
    peripheralId: v.peripheralId,
    name: typeof v.name === 'string' ? v.name : 'DashPal',
    pairedAt: typeof v.pairedAt === 'number' ? v.pairedAt : 0,
    secure: true,
  };
}

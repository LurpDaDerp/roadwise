// The DashPal settings keys (SQLite `settings`; every one starts with `dashcam.`, which the handover
// wipe keeps: the pairing belongs to the phone) and the SecureStore flag the transport reads at
// module load, before SQLite is open.
import { isDashcamId } from './protocol';

export const PAIRED_KEY = 'dashcam.paired';
export const BUZZER_TOO_KEY = 'dashcam.buzzerToo';
/** The driver asked for DashPal at least once: the auto-detect prompt may scan (never prompts for permission). */
export const BT_OPT_IN_KEY = 'dashcam.btOptIn';
/** `{ [dashcamId]: snoozedUntilMs }`: "Not now" on the auto prompt, 7 days per dashcam. */
export const SNOOZES_KEY = 'dashcam.snoozes';

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
}

/** A stored value as a paired record, or null when it is not one. */
export function asPaired(value: unknown): PairedDashcam | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!isDashcamId(v.dashcamId) || typeof v.peripheralId !== 'string' || v.peripheralId.length === 0) return null;
  return {
    dashcamId: v.dashcamId,
    peripheralId: v.peripheralId,
    name: typeof v.name === 'string' ? v.name : 'DashPal',
    pairedAt: typeof v.pairedAt === 'number' ? v.pairedAt : 0,
  };
}

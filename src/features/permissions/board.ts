/**
 * The permission board: one read of the phone (`readPermissionBoard`) and the pure rules that turn
 * it into Home's single row and Settings › Permissions' list. A read never prompts and never starts
 * the BLE manager; the Bluetooth permission is read only for a phone with a DashPal paired.
 */
import type { TripReminderStatus } from '@drive-sense';

import type { BluetoothPermission, CameraAccess, PermissionPlatform, PermissionSnapshot } from '@/core/permissions';

import type { HomePrefs } from './homePrefs';
import { PERMISSIONS, signature, type PermissionBoardRead, type PermissionDef, type PermissionId, type PermState } from './registry';

export interface BoardReadDeps {
  /** The shared snapshot; a failure makes the whole board unreadable. */
  snapshot(): Promise<PermissionSnapshot>;
  androidApi: number | null;
  /** A DashPal pairing is stored. */
  paired(): Promise<boolean>;
  bluetoothPermission(): Promise<BluetoothPermission>;
  camera(): Promise<CameraAccess>;
  reminder(): Promise<TripReminderStatus>;
}

const orNull = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

/** One read of the phone. Throws only when the snapshot cannot be read; any other failed read nulls its own field. */
export async function readPermissionBoard(deps: BoardReadDeps): Promise<PermissionBoardRead> {
  const [snapshot, paired, camera, reminder] = await Promise.all([
    deps.snapshot(),
    deps.paired().catch(() => false),
    orNull(deps.camera),
    orNull(deps.reminder),
  ]);
  const bluetooth = paired ? await orNull(deps.bluetoothPermission) : null;
  return { snapshot, androidApi: snapshot.platform === 'android' ? deps.androidApi : null, paired, bluetooth, camera, reminder };
}

export interface BoardRow {
  id: PermissionId;
  def: PermissionDef;
  state: PermState;
}

const onPlatform = (platform: PermissionPlatform) => PERMISSIONS.filter((d) => d.platforms.includes(platform));

const byOrder = (a: BoardRow, b: BoardRow) => a.def.order - b.def.order;

/** Every permission of this platform with its state, in order. */
export function boardRows(read: PermissionBoardRead): BoardRow[] {
  return onPlatform(read.snapshot.platform)
    .map((def) => ({ id: def.id, def, state: def.state(read) }))
    .sort(byOrder);
}

export type Fix = 'request' | 'settings';

/**
 * What a tap on a missing row does: ask the phone while it can still ask and no earlier request
 * for this very state had no effect; otherwise open Settings. null for a row that is not missing.
 */
export function fixFor(id: PermissionId, state: PermState, prefs: HomePrefs): Fix | null {
  if (state.kind !== 'missing') return null;
  return state.canAsk && prefs.toSettings[id] !== signature(state) ? 'request' : 'settings';
}

export interface HomeCard {
  /** The first visible row; null shows no card. */
  row: BoardRow | null;
  /** How many more rows are visible. */
  more: number;
}

/** Home shows a row exactly when it is missing, has a Home row, is not hidden, and no drive records. */
export function homeCard(read: PermissionBoardRead, prefs: HomePrefs, recording: boolean): HomeCard {
  if (recording) return { row: null, more: 0 };
  const visible = boardRows(read).filter((r) => r.def.homeRow && r.state.kind === 'missing' && !prefs.hidden.includes(r.id));
  return { row: visible[0] ?? null, more: Math.max(0, visible.length - 1) };
}

export interface SettingsRow extends BoardRow {
  /** Missing and hidden from Home: the row offers Show on Home. */
  hiddenFromHome: boolean;
}

/**
 * Settings › Permissions: every permission of this platform, except Precise Location while location
 * is not allowed, motion on a phone that cannot report it, and the reminder's channel on Android
 * while the reminder is off.
 */
export function settingsRows(read: PermissionBoardRead, prefs: HomePrefs): SettingsRow[] {
  return boardRows(read)
    .filter((r) => {
      if (r.id === 'precise') return r.state.kind !== 'idle';
      if (r.id === 'motion') return r.state.kind !== 'unknown';
      if (r.id === 'reminderAccess' && read.snapshot.platform === 'android') return read.reminder?.enabled === true;
      return true;
    })
    .map((r) => ({ ...r, hiddenFromHome: r.state.kind === 'missing' && prefs.hidden.includes(r.id) }));
}

export type Overall = 'ok' | 'attention' | 'broken';

/** The summary: broken while a drive cannot record; ok when nothing is missing. */
export function overall(rows: readonly BoardRow[]): Overall {
  if (rows.some((r) => r.def.need === 'required' && r.state.kind === 'missing')) return 'broken';
  return rows.every((r) => r.state.kind !== 'missing') ? 'ok' : 'attention';
}

/** Whether a stored "no effect" signature still applies to this read. */
export function toSettingsApplies(read: PermissionBoardRead, id: PermissionId, sig: string): boolean {
  const def = PERMISSIONS.find((d) => d.id === id);
  if (!def) return false;
  const state = def.state(read);
  return state.kind === 'missing' && signature(state) === sig;
}

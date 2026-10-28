// What the DashPal screens say about the link (plan §7.9): one status line, its fix, and the dot
// colour the HUD chip uses. Pure.
import { dashpalCopy } from '../copy';
import { DASHCAM_STATE } from '../protocol';
import type { DashcamState } from '../runtime';

export type DashcamStatusKind =
  | 'unpaired'
  | 'monitoring'
  | 'calibrating'
  | 'connected'
  | 'not_in_range'
  | 'bluetooth_off'
  | 'not_allowed'
  | 'needs_repair'
  | 'downgrade'
  | 'update_app'
  | 'unverified';

export interface DashcamStatus {
  kind: DashcamStatusKind;
  label: string;
  /** What to do about it; null when nothing is wrong. */
  fix: string | null;
  /** The chip's dot: ok (connected), warn (not connected, or a device that cannot prove it is the DashPal), bad (needs the driver). */
  dot: 'ok' | 'warn' | 'bad';
  /** The camera needs re-aiming (STATUS bit 7, kept while the DashPal is off): a yellow dot in place of an ok or a warn one. */
  reaim: boolean;
}

const s = dashpalCopy.screen;

export function dashcamStatus(state: DashcamState | null): DashcamStatus {
  const s = linkStatus(state);
  return { ...s, reaim: s.kind !== 'unpaired' && state?.reaim === true };
}

function linkStatus(state: DashcamState | null): Omit<DashcamStatus, 'reaim'> {
  const link = state?.link;
  if (!link || !link.paired) return { kind: 'unpaired', label: dashpalCopy.settingsRow.subtitle.unpaired, fix: null, dot: 'warn' };
  switch (link.lifecycle) {
    case 'needs_repair':
      if (link.repairCause === 'downgrade') return { kind: 'downgrade', label: s.status.downgrade, fix: s.fix.downgrade, dot: 'bad' };
      if (link.repairCause === 'update_app') return { kind: 'update_app', label: s.status.updateApp, fix: s.fix.updateApp, dot: 'bad' };
      return { kind: 'needs_repair', label: s.status.needsRepair, fix: s.fix.needsRepair, dot: 'bad' };
    case 'unverified':
      return { kind: 'unverified', label: s.status.unverified, fix: s.fix.unverified, dot: 'warn' };
    case 'unauthorized':
      return { kind: 'not_allowed', label: s.status.notAllowed, fix: s.fix.notAllowed, dot: 'bad' };
    case 'bluetooth_off':
      return { kind: 'bluetooth_off', label: s.status.bluetoothOff, fix: s.fix.bluetoothOff, dot: 'bad' };
    case 'connected': {
      const st = link.status?.state;
      if (st === DASHCAM_STATE.MONITORING) return { kind: 'monitoring', label: s.status.monitoring, fix: null, dot: 'ok' };
      if (st === DASHCAM_STATE.CALIBRATING) return { kind: 'calibrating', label: s.status.calibrating, fix: null, dot: 'ok' };
      return { kind: 'connected', label: s.status.connected, fix: null, dot: 'ok' };
    }
    default:
      return { kind: 'not_in_range', label: s.status.notInRange, fix: s.fix.notInRange, dot: 'warn' };
  }
}

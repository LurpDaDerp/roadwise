import { requireNativeModule } from 'expo-modules-core';

export type DriveSenseState = { armed: boolean; capturing: boolean; platform: 'ios' | 'android' };

/**
 * The event names both native modules declare. M0 ships the names only; the emitters and the
 * capture pipeline behind them land in M3. Keep this list byte-identical to the `Events(...)`
 * lists in `ios/DriveSenseModule.swift` and `android/.../DriveSenseModule.kt`.
 */
export const DRIVE_SENSE_EVENTS = [
  'wake',
  'activity',
  'row',
  'screen',
  'thermal',
  'notificationAction',
] as const;

export type DriveSenseEvent = (typeof DRIVE_SENSE_EVENTS)[number];

type Native = { getState(): Promise<DriveSenseState> };

const native = requireNativeModule<Native>('DriveSense');

const DriveSense = { getState: () => native.getState() };

export default DriveSense;

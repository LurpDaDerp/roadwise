// The hooks screens read the drive through (modes plan §3.9).
import type { EventType, Tier } from '@scoring';
import { useCallback, useContext, useMemo } from 'react';

import type { DriveOrigin, EventShake } from '@/core/engine/engine.types';
import type { DropReason } from '@/core/engine/finalize';
import type { SpotNudge } from '@/core/spots/types';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { DangerAlert } from '@/features/weather/danger';
import { mpsToMph } from '@/lib/units';

import { DriveContext, type DriveContextValue } from './DriveProvider';
import type { DriveHost, DriveState, ShownWeather, StartResult } from './host';
import type { WaitingPublic } from './waiting';

function useDriveContext(): DriveContextValue {
  const value = useContext(DriveContext);
  if (value === null) throw new Error('useDrive must be used inside <DriveProvider>');
  return value;
}

/**
 * A slice of the drive state. The selector's result is compared shallowly, so an object selector
 * re-renders only when one of its fields changes, not on every 1 Hz row.
 */
export function useDrive<T>(selector: (s: DriveState) => T): T {
  const { store } = useDriveContext();
  return useStore(store, useShallow(selector));
}

/** The host itself, for the few callers outside the two contracts below. */
export function useDriveHost(): DriveHost {
  return useDriveContext().host;
}

export interface DriveControls {
  /** Start Drive: a drive records from the tap, waiting for driving speed (the driving screen opens with the wait's band). */
  start(): Promise<StartResult>;
  /** End the drive; resolves once it is finalized (`dropped`: it was not kept). Navigation is the caller's job. */
  end(): Promise<{ clientTripId: string; dropped: DropReason | null } | null>;
  /** Any touch on the waiting screen, and "Keep waiting": a fresh 5 min. */
  touchWaiting(): void;
  /** "Cancel" while waiting: nothing is stored. */
  cancelWaiting(): Promise<void>;
  /** "Not driving?": the drive is discarded; false when it is no longer offered. */
  cancelDrive(): Promise<boolean>;
  /** The driving screen's focus (true on focus, false on blur and unmount): the "Not driving?" budget counts while it shows. */
  setHudVisible(visible: boolean): void;
  /** The weather banner's ✕: hidden for the rest of the drive (a more severe kind shows again). */
  dismissWeather(): void;
  /** DEMO: plays the phone-pickup alert. */
  demoPhoneAlert(): void;
}

export function useDriveControls(): DriveControls {
  const host = useDriveHost();
  return useMemo(
    () => ({
      start: () => host.start(),
      end: () => host.end(),
      touchWaiting: () => host.touchWaiting(),
      cancelWaiting: () => host.cancelWaiting(),
      cancelDrive: () => host.cancelDrive(),
      setHudVisible: (visible: boolean) => host.setHudVisible(visible),
      dismissWeather: () => host.dismissWeather(),
      demoPhoneAlert: () => host.demoPhoneAlert(),
    }),
    [host]
  );
}

export interface DriveLive {
  status: 'idle' | 'recording' | 'finalizing';
  clientTripId: string | null;
  /** How the open drive began; null when none records. */
  origin: DriveOrigin | null;
  /** The newest row's GPS speed (mph, tenths), null when it had none: the halo's speeding hold. */
  rowSpeedMph: number | null;
  /** The limit the sign shows (the last one held up to 10 s through a row without one); null → "-". */
  limitMph: number | null;
  speedingTier: Tier | null;
  /**
   * The speed shown over the limit the sign shows (1 = at the limit); null while the sign shows "-".
   * The halo's tint, from the first row the sign has a number.
   */
  speedingRatio: number | null;
  /** The current row is over the speeding line (L + T): the halo pulses. */
  speedingOver: boolean;
  /** The last GPS course (degrees clockwise from true north) taken at 5 mph or more, held; null before the first. */
  courseDeg: number | null;
  /** The latest event the halo shakes on (a hard event, a phone pickup, a speeding episode as it alerts), with its tier; null before the first. */
  lastShake: EventShake | null;
  stopped: boolean;
  lastAlert: { type: EventType; tier: Tier; at: number } | null;
  /** The dangerous-weather alert at the car (unless dismissed this drive), or null. */
  weatherAlert: DangerAlert | null;
  /** The same alert's kind and title, as the Live Activity shows it. */
  weather: ShownWeather | null;
  startedAt: number | null;
  /** The newest row's time (the row clock), or null before any row. */
  rowTs: number | null;
  /** A Start-card drive still waiting for driving speed (it records from the tap), or null. */
  waiting: WaitingPublic | null;
  /** "Not driving?" is still offered on this drive. */
  notDrivingAvailable: boolean;
  /** The spot nudge to flash ("Watch your speed here"), or null. */
  spotNudge: SpotNudge | null;
}

const selectLive = (s: DriveState) => ({
  status: s.status,
  clientTripId: s.clientTripId,
  origin: s.origin,
  rowSpeedMph: s.rowSpeedMps === null ? null : Math.round(mpsToMph(s.rowSpeedMps) * 10) / 10,
  limitMph: s.limitMph,
  speedingTier: s.speedingTier,
  speedingRatio: s.speedingRatio,
  speedingOver: s.speedingOver,
  courseDeg: s.courseDeg,
  lastShake: s.lastShake,
  stopped: s.stopped,
  lastAlert: s.lastAlert,
  weatherAlert: s.weatherAlert,
  weather: s.weather,
  startedAt: s.startedAt,
  rowTs: s.lastRowTs,
  waiting: s.waiting,
  notDrivingAvailable: s.notDrivingAvailable,
  spotNudge: s.spotNudge,
});

/** The speed the driving screen shows, as of its last fix (`displaySpeed.ts`). */
export interface ShownSpeed {
  /** m/s at `at`; null with no drive (the screen shows "-"). */
  mps: number | null;
  /** m/s² to carry it on with from `at`; 0: not carried. */
  accel: number;
  /** The time `mps` stands for (host clock), null before the drive's first fix. */
  at: number | null;
}

const selectShown = (s: DriveState): ShownSpeed => ({
  mps: s.speedKnown ? s.speedMps : null,
  accel: s.speedKnown ? s.speedAccelMps2 : 0,
  at: s.speedKnown ? s.speedAt : null,
});

/** The halo's number alone: it changes with every fix, so only the readout reads it. */
export function useShownSpeed(): ShownSpeed {
  return useDrive(selectShown);
}

const selectHeading = (s: DriveState): number | null => s.courseDeg ?? null;

/** The compass's heading alone (`DriveLive.courseDeg`): degrees clockwise from true north, or null. */
export function useHeading(): number | null {
  return useDrive(selectHeading);
}

/** The compass's bearing from where the car went (`EngineSnapshot.bearingDeg`), and where it came from. */
export interface DriveBearing {
  /** Degrees clockwise from true north, [0, 360), held while stopped; null before the drive's first and with no drive. */
  deg: number | null;
  /** `'track'` (the car's movement) whenever `deg` is known; null with none (show the phone's own heading). */
  source: 'track' | null;
}

export const selectBearing = (s: DriveState): DriveBearing => ({ deg: s.bearingDeg ?? null, source: s.bearingSource ?? null });

/** The compass's bearing alone: re-renders only when it (or its source) changes. */
export function useBearing(): DriveBearing {
  return useDrive(selectBearing);
}

/** Everything the driving screen shows; published at most once per row (1 Hz). */
export function useDriveLive(): DriveLive {
  const live = useDrive(selectLive);
  const lastAlert = useMemo(
    () => (live.lastAlert === null ? null : { type: live.lastAlert.type, tier: live.lastAlert.tier, at: live.lastAlert.at }),
    [live.lastAlert]
  );
  return { ...live, lastAlert };
}

/** A stable callback to start a drive, for Home's button. */
export function useStartDrive(): () => Promise<StartResult> {
  const host = useDriveHost();
  return useCallback(() => host.start(), [host]);
}

// The hooks screens read the drive through (plan §10).
import type { EventType, Tier } from '@scoring';
import { useCallback, useContext, useMemo } from 'react';

import type { DropReason } from '@/core/engine/finalize';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { useDriveWeather, WEATHER_REFETCH_DISTANCE_M } from '@/features/drive/weather';
import type { DangerAlert } from '@/features/weather/danger';
import { mpsToMph } from '@/lib/units';

import { DriveContext, type DriveContextValue } from './DriveProvider';
import type { DriveHost, DriveState, StartResult } from './host';

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
  /** Start Drive. Only from a user tap; at any speed. */
  start(): Promise<StartResult>;
  /** End the drive; resolves once it is finalized (`dropped`: it was not kept). Navigation is the caller's job. */
  end(): Promise<{ clientTripId: string; dropped: DropReason | null } | null>;
}

export function useDriveControls(): DriveControls {
  const host = useDriveHost();
  return useMemo(() => ({ start: () => host.start(), end: () => host.end() }), [host]);
}

export interface DriveLive {
  status: 'idle' | 'recording' | 'finalizing';
  clientTripId: string | null;
  /** The speed to show as of the newest row; null → show "-". */
  speedMph: number | null;
  /** The acceleration (mph/s) the screen carries `speedMph` on with until the next row; 0: not carried. */
  speedAccelMph: number;
  /** The limit the sign shows (the last one held up to 10 s through a row without one); null → "-". */
  limitMph: number | null;
  speedingTier: Tier | null;
  stopped: boolean;
  lastAlert: { type: EventType; tier: Tier; at: number } | null;
  /** The dangerous-weather alert near the car (plan D14), or null. */
  weatherAlert: DangerAlert | null;
  /** Non-null only while stopped (≤ 5 mph). */
  points: { total: number; sinceLastStop: number } | null;
  startedAt: number | null;
  /** The newest row's time (the row clock), or null before any row. */
  rowTs: number | null;
  /** The confirmed phone episode's first use row while it is open (row clock), else null. */
  phoneUseSince: number | null;
}

const selectLive = (s: DriveState) => ({
  status: s.status,
  clientTripId: s.clientTripId,
  // Tenths, not whole mph: the HUD rounds once in the driver's unit (km/h would round twice).
  speedMph: s.speedKnown ? Math.round(mpsToMph(s.speedMps) * 10) / 10 : null,
  speedAccelMph: s.speedKnown ? Math.round(mpsToMph(s.speedAccelMps2) * 10) / 10 : 0,
  limitMph: s.limitMph,
  speedingTier: s.speedingTier,
  stopped: s.stopped,
  lastAlert: s.lastAlert,
  points: s.points,
  startedAt: s.startedAt,
  rowTs: s.lastRowTs,
  phoneUseSince: s.phoneUseSince,
});

/** The weather leg: changes once per refetch distance, so the odometer never re-renders the HUD per row. */
const selectWeatherLeg = (s: DriveState) => Math.floor(s.distanceM / WEATHER_REFETCH_DISTANCE_M);

/** Everything the driving screen shows; published at most once per row (1 Hz). */
export function useDriveLive(): DriveLive {
  const live = useDrive(selectLive);
  const leg = useDrive(selectWeatherLeg);
  const weatherAlert = useDriveWeather(live.status === 'recording', leg * WEATHER_REFETCH_DISTANCE_M);
  const lastAlert = useMemo(
    () => (live.lastAlert === null ? null : { type: live.lastAlert.type, tier: live.lastAlert.tier, at: live.lastAlert.at }),
    [live.lastAlert]
  );
  return { ...live, lastAlert, weatherAlert };
}

/** A stable callback to start a drive, for Home's button. */
export function useStartDrive(): () => Promise<StartResult> {
  const host = useDriveHost();
  return useCallback(() => host.start(), [host]);
}

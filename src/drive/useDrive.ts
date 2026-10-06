// The hooks screens read the drive through (plan §10).
import type { EventType, Tier } from '@scoring';
import { useCallback, useContext, useMemo } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { useWeatherHazard, WEATHER_REFETCH_DISTANCE_M, weatherLabel } from '@/features/drive/weather';
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
  /** Start Drive. Only from a user tap in the foreground; refuses (`moving`) at ≥ 3 mph. */
  start(opts: { dmsOn: boolean }): Promise<StartResult>;
  /** End the drive; resolves once it is finalized. Navigation is the caller's job. */
  end(): Promise<{ clientTripId: string } | null>;
}

export function useDriveControls(): DriveControls {
  const host = useDriveHost();
  return useMemo(() => ({ start: (opts) => host.start(opts), end: () => host.end() }), [host]);
}

export interface DriveLive {
  status: 'idle' | 'recording' | 'finalizing';
  clientTripId: string | null;
  /** null → show "—". */
  speedMph: number | null;
  limitMph: number | null;
  speedingTier: Tier | null;
  stopped: boolean;
  lastAlert: { type: EventType; tier: Tier; at: number } | null;
  weatherAlert: string | null;
  /** Non-null only while stopped (≤ 5 mph). */
  points: { total: number; sinceLastStop: number } | null;
  startedAt: number | null;
  dmsActive: boolean;
}

const selectLive = (s: DriveState) => ({
  status: s.status,
  clientTripId: s.clientTripId,
  speedMph: s.speedKnown ? Math.round(mpsToMph(s.speedMps)) : null,
  limitMph: s.limitMph,
  speedingTier: s.speedingTier,
  stopped: s.stopped,
  lastAlert: s.lastAlert,
  points: s.points,
  startedAt: s.startedAt,
  dmsActive: s.dmsActive,
});

/** The weather leg: changes once per refetch distance, so the odometer never re-renders the HUD per row. */
const selectWeatherLeg = (s: DriveState) => Math.floor(s.distanceM / WEATHER_REFETCH_DISTANCE_M);

/** Everything the driving screen shows; published at most once per row (1 Hz). */
export function useDriveLive(): DriveLive {
  const live = useDrive(selectLive);
  const leg = useDrive(selectWeatherLeg);
  const hazard = useWeatherHazard(live.status === 'recording', leg * WEATHER_REFETCH_DISTANCE_M);
  const lastAlert = useMemo(
    () => (live.lastAlert === null ? null : { type: live.lastAlert.type, tier: live.lastAlert.tier, at: live.lastAlert.at }),
    [live.lastAlert]
  );
  return { ...live, lastAlert, weatherAlert: hazard === null ? null : weatherLabel(hazard) };
}

/** A stable callback to start a drive, for Home's button. */
export function useStartDrive(): (opts: { dmsOn: boolean }) => Promise<StartResult> {
  const host = useDriveHost();
  return useCallback((opts: { dmsOn: boolean }) => host.start(opts), [host]);
}

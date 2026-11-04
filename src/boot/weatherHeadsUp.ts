/**
 * The weather heads-up before the usual commute, attached to the launch's drive host
 * (`src/features/weather/commuteHeadsUp.ts`). Attached on every launch, a background one too: a
 * drive that starts on its own while nobody opened RoadWise must still take every heads-up down.
 * It plans on the driver bringing RoadWise to the front and after a drive closes; it never asks
 * for a permission and never starts a drive. Not from the notification plumbing, which may not
 * reach the drive host.
 */
import type { Db } from '@/data/db';
import type { AppStateLike } from '@/data/foreground';
import type { DriveHost } from '@/drive/host';

/** The planner as the launch holds it. */
export interface LaunchWeatherHeadsUp {
  detach(): void;
  settled?(): Promise<void>;
}

export interface WeatherHeadsUpArgs {
  /** Whether a driver is signed in now; rejects when it cannot be read (unknown: plans as before). */
  signedIn: () => Promise<boolean>;
  /** The launch's app state: the plan on coming to the front. */
  appState: AppStateLike;
  now: () => number;
  onError: (error: unknown, context: string) => void;
}

export function defaultWeatherHeadsUp(host: DriveHost, db: Db, args: WeatherHeadsUpArgs): LaunchWeatherHeadsUp {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: the notifications native module
  const { attachCommuteHeadsUp } = require('@/features/weather/commuteHeadsUp') as typeof import('@/features/weather/commuteHeadsUp');
  return attachCommuteHeadsUp(host, { db, signedIn: args.signedIn, appState: args.appState, now: args.now, onError: (error, context) => args.onError(error, context) });
}

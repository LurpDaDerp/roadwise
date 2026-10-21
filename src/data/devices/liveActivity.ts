/**
 * Asking the server to start the drive's Live Activity by push (`live-activity-start`, iOS 17.2+):
 * the drive host calls it once per drive when a drive starts on its own with RoadWise not in front,
 * so the lock screen shows it. The server sends the ActivityKit push-to-start to the token this
 * install registered (`register_device`), at most once per drive.
 *
 * It never throws and never waits long: no token, no network, a server without the function or
 * any other failure is simply `false`, and the drive's own "Recording your drive" notification
 * stands in. Nothing about the drive is stored here.
 */
import type { LiveDriveState } from '@live-drive';

export const LIVE_ACTIVITY_START_FUNCTION = 'live-activity-start';
/** The longest the host waits for an answer; a later one is not waited for. */
export const LIVE_ACTIVITY_START_TIMEOUT_MS = 10_000;

export interface LiveActivityStartRequest {
  /** This install's id (`getInstallId`): the device row whose token the push goes to. */
  deviceId: string;
  clientTripId: string;
  /** The drive's start, epoch ms (the activity's `startedAt`). */
  startedAt: number;
  /** The first lock-screen state (weather none: the push never carries it). */
  state: LiveDriveState;
}

export interface LiveActivityStartDeps {
  /** `supabase.functions.invoke`; the app's own client when absent. */
  invoke?: (name: string, options: { body: unknown }) => Promise<{ data: unknown; error: unknown }>;
  timeoutMs?: number;
  onError?: (error: unknown, context: string) => void;
}

function defaultInvoke(): NonNullable<LiveActivityStartDeps['invoke']> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the app client, only when called for real
  const { supabase } = require('@/data/supabase/client') as typeof import('@/data/supabase/client');
  return (name, options) => supabase.functions.invoke(name, options);
}

/** True when the server sent the push (`{ sent: true }`); false on anything else. Never throws. */
export async function requestLiveActivityStart(req: LiveActivityStartRequest, deps: LiveActivityStartDeps = {}): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const invoke = deps.invoke ?? defaultInvoke();
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deps.timeoutMs ?? LIVE_ACTIVITY_START_TIMEOUT_MS);
    });
    const body = { deviceId: req.deviceId, clientTripId: req.clientTripId, startedAt: req.startedAt, state: req.state };
    const reply = await Promise.race([invoke(LIVE_ACTIVITY_START_FUNCTION, { body }), timeout]);
    if (reply === null || reply.error) return false;
    const data = reply.data;
    return typeof data === 'object' && data !== null && (data as { sent?: unknown }).sent === true;
  } catch (error) {
    try {
      deps.onError?.(error instanceof Error ? new Error(error.name) : new Error('live activity start failed'), 'live activity start');
    } catch {
      // nobody left to tell
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

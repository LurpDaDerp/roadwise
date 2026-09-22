/**
 * Tells the server whether this phone is recording a drive, so `push-sender` holds pushes while
 * the driver drives (0007: a claim reads `recording` as driving for at most 6 hours).
 *
 * The rules (rev1: O4):
 * - `recording` is written once, when the engine's status becomes `recording`;
 * - `idle` is written once, when it leaves `recording`/`ending` for `armed`, `off` or `finalizing`;
 * - a candidate that is discarded never writes anything, and neither does an armed, idle phone;
 * - a failed `idle` is kept and sent again by `retryPending()` (the next foreground). A lost one is
 *   bounded by the server's 6-hour staleness, so nothing retries on a timer.
 * - only `drive_state` is sent: the server stamps `drive_state_at` on every write (T2 M-1).
 *
 * Writes go out one at a time, in order, so a slow `recording` can never land after its `idle`.
 * Battery (§3.5): each state change costs one comparison; the network is touched twice per drive.
 */
import type { DriveState } from '@/drive/host';

import { asError, type DevicesClient } from './register';

export interface DriveStateReporterDeps {
  supabase: DevicesClient;
  userId: string;
  deviceId: string;
  onError?: (error: unknown, context: string) => void;
}

export interface DriveStateReporter {
  onDriveState(s: Pick<DriveState, 'status'>): void;
  /** Sends an `idle` that failed, if the phone is still not recording. */
  retryPending(): Promise<void>;
  /** Resolves once every write started so far has settled (tests, orderly teardown). */
  settled(): Promise<void>;
}

type Reported = 'idle' | 'recording';

export function createDriveStateReporter(deps: DriveStateReporterDeps): DriveStateReporter {
  const { supabase, userId, deviceId } = deps;
  /** What the server was last told (or is being told). Starts idle: launching writes nothing. */
  let reported: Reported = 'idle';
  let pendingIdle = false;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    chain = chain.then(work, work);
    return chain;
  };

  /** One write; true when it reached this install's row. */
  async function write(state: Reported): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('devices')
        .update({ drive_state: state })
        .eq('user_id', userId)
        .eq('id', deviceId)
        .select('id');
      if (error) throw error;
      if (!Array.isArray(data) || data.length === 0) throw new Error('no device row for this install');
      return true;
    } catch (error) {
      deps.onError?.(asError(error, `drive state ${state} failed`), 'devices drive state');
      return false;
    }
  }

  async function sendIdle(): Promise<void> {
    // a new drive started while this waited: the idle is stale
    if (reported !== 'idle') return;
    pendingIdle = !(await write('idle')) && reported === 'idle';
  }

  return {
    onDriveState(s) {
      const status = s.status;
      if (status === 'recording') {
        if (reported === 'recording') return;
        reported = 'recording';
        pendingIdle = false;
        void enqueue(async () => {
          await write('recording');
        });
        return;
      }
      if ((status === 'armed' || status === 'off' || status === 'finalizing') && reported === 'recording') {
        reported = 'idle';
        void enqueue(sendIdle);
      }
      // candidate and ending change nothing
    },
    retryPending() {
      if (!pendingIdle || reported !== 'idle') return chain;
      return enqueue(async () => {
        // an earlier retry in the queue may already have sent it
        if (pendingIdle) await sendIdle();
      });
    },
    settled: () => chain,
  };
}

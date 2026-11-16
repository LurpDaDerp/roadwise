import { useEffect, useMemo, useState } from 'react';
import { AppState, Platform } from 'react-native';

import type { PermissionsAdapter } from '@/core/permissions';
import type { DisclosureNext } from '@/features/permissions/copy';
import { defaultPermissionsAdapter } from '@/features/permissions/usePermissionHealth';

import { dashpalSecrets, type DashpalSecrets } from '../../secure';
import { createSetupFlow, type SetupDeps, type SetupFlow, type SetupPhase, type SetupStart } from '../../setup';
import { markSetupOpen } from '../setupOpen';
import { useDashcamRuntime } from '../useDashcam';
import { useDriveBusy, useDriveChanges } from '../useDriveBusy';

export interface SetupFlowDeps {
  adapter?: PermissionsAdapter;
  platform?: 'ios' | 'android';
  flow?: (base: SetupDeps) => SetupFlow;
  secrets?: DashpalSecrets;
  now?: () => number;
  /**
   * Shows Google Play's background-location disclosure (the sheet's `useBackgroundDisclosure().ask`):
   * true once the driver chose Continue. Without it, a request that needs it asks nothing.
   */
  disclose?: (next: DisclosureNext) => Promise<boolean>;
}

/**
 * The setup flow (`../../setup.ts`) wired to the runtime, the drive host and the permissions
 * adapter, started with `start` while `active` and cancelled when it stops being active (a closed
 * sheet, an unmount): Cancel undoes a pairing already made. `restart` starts a new flow (Try again
 * after a failure that starts over). While active, Home's card does not scan.
 */
export function useSetupFlow({ start, deps = {}, active = true, onPhase }: { start: SetupStart; deps?: SetupFlowDeps; active?: boolean; onPhase?(p: SetupPhase): void }) {
  const runtime = useDashcamRuntime();
  const isBusy = useDriveBusy();
  const onDriveChange = useDriveChanges();
  const platform = deps.platform ?? (Platform.OS === 'ios' ? 'ios' : 'android');
  const now = deps.now ?? Date.now;
  const [seen, setSeen] = useState<{ flow: SetupFlow | null; phase: SetupPhase }>({ flow: null, phase: { kind: 'idle' } });
  const [attempt, setAttempt] = useState(0);
  const adapter = useMemo(() => deps.adapter ?? defaultPermissionsAdapter(), [deps.adapter]);
  // A stable callback (`useBackgroundDisclosure().ask`), so it never starts a new flow by itself.
  const disclose = deps.disclose;

  const flow = useMemo(() => {
    void attempt;
    const base: SetupDeps = {
      platform,
      transport: () => runtime?.transport() ?? null,
      // Android 11 and lower ask fine location for the DashPal's scans; on Android 9 and lower with the
      // drive detector that allows background location too, so Google Play's disclosure comes first,
      // and Not now asks nothing (the step then reads not allowed, with Try again).
      requestBluetooth: async () => {
        if (platform !== 'android' || !(await adapter.locationAskIsBackground())) return adapter.requestBluetooth();
        const ask = disclose;
        if (!ask || !(await ask('allow'))) return 'undetermined';
        return adapter.requestBluetooth({ disclosed: true });
      },
      isBusy,
      onDriveChange,
      optIn: async () => runtime?.optIn(),
      pair: async (record) => runtime?.pair(record),
      paired: () => runtime?.state().link.paired ?? null,
      keyRefused: (d) => {
        const l = runtime?.state().link;
        return l?.repairCause === 'unknown_phone' && l.paired?.dashcamId === d;
      },
      stepAside: () => runtime?.stepAside(),
      resumePaired: async () => runtime?.resumePaired(),
      secrets: deps.secrets ?? dashpalSecrets,
      notePhones: (dashcamId, phones) => runtime?.notePhones(dashcamId, phones),
      // Screen 3's picture stops when RoadWise leaves the front and starts again when it is back.
      onAppState: (fn) => {
        const sub = AppState.addEventListener('change', (s) => fn(s === 'active'));
        return () => sub.remove();
      },
      now,
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    };
    return (deps.flow ?? createSetupFlow)(base);
    // A new flow for each attempt and each opening (a cancelled one finishes its undo on its own).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, active, adapter, deps.flow, deps.secrets, disclose, platform, runtime, isBusy, onDriveChange]);

  const startKey = JSON.stringify(start);
  useEffect(() => {
    if (!active) return;
    const closed = markSetupOpen();
    const off = flow.subscribe((p) => {
      setSeen({ flow, phase: p });
      onPhase?.(p);
    });
    void flow.start(start);
    return () => {
      off();
      closed();
      void flow.cancel();
    };
    // `start` is read by value (`startKey`); `onPhase` live through the subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, active, startKey]);

  // A new flow shows idle until it says otherwise.
  const phase: SetupPhase = seen.flow === flow ? seen.phase : { kind: 'idle' };
  return { phase, flow, adapter, restart: () => setAttempt((n) => n + 1) };
}

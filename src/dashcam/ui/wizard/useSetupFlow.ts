import { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';

import type { PermissionsAdapter } from '@/core/permissions';
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

  const flow = useMemo(() => {
    void attempt;
    const base: SetupDeps = {
      platform,
      transport: () => runtime?.transport() ?? null,
      requestBluetooth: () => adapter.requestBluetooth(),
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
      now,
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    };
    return (deps.flow ?? createSetupFlow)(base);
    // A new flow for each attempt and each opening (a cancelled one finishes its undo on its own).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, active, adapter, deps.flow, deps.secrets, platform, runtime, isBusy, onDriveChange]);

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

import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { PermissionsAdapter } from '@/core/permissions';
import { createSettingsRepo } from '@/data/db/settings';
import type { AppStateLike } from '@/data/foreground';
import { useDb } from '@/data/queries/context';
import { isBusyStatus } from '@/drive/policy';
import { useDriveHost } from '@/drive/useDrive';
import { defaultPermissionsAdapter } from '@/features/permissions/usePermissionHealth';
import { mpsToMph } from '@/lib/units';

import { createDetector, snoozed, type Detector, type Found } from '../detector';
import { SNOOZES_KEY } from '../keys';
import type { DashcamRuntime, DashcamState } from '../runtime';
import type { SetupStart } from '../setup';
import { NewPhoneCard } from './NewPhoneCard';
import { PairCard } from './PairCard';
import { isSetupOpen } from './setupOpen';
import { useDashcamRuntime, useDashcamSelector } from './useDashcam';
import { PairWizardSheet } from './wizard/PairWizardSheet';
import type { SetupFlowDeps } from './wizard/useSetupFlow';

export interface HomeDashpalDeps {
  adapter?: PermissionsAdapter;
  appState?: AppStateLike;
  speedMph?: () => Promise<number | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** the setup sheet's own deps (tests) */
  setup?: SetupFlowDeps;
}

/**
 * Home's DashPal slot: the one-time new-phone card, and under it the card of a DashPal ready to pair
 * nearby (`../detector.ts`: looked for when Home comes into view, when RoadWise returns to the front
 * on Home, and on pull to refresh, `pull` counting the pulls), which opens the setup sheet on that
 * DashPal. The cards hide while a drive records; an open sheet stays (setup says it stopped).
 */
export function HomeDashpal({ hidden = false, pull = 0, deps = {} }: { hidden?: boolean; pull?: number; deps?: HomeDashpalDeps }) {
  const runtime = useDashcamRuntime();
  const [setup, setSetup] = useState<SetupStart | null>(null);
  return (
    <>
      <NewPhoneCard hidden={hidden} />
      {runtime && !hidden ? <PairOffer runtime={runtime} pull={pull} deps={deps} onOpen={setSetup} /> : null}
      {runtime ? <PairWizardSheet start={setup} onClose={() => setSetup(null)} deps={deps.setup} /> : null}
    </>
  );
}

const selectConnected = (s: DashcamState | null): boolean => s?.link.paired !== null && s?.link.lifecycle === 'connected';

function PairOffer({ runtime, pull, deps, onOpen }: { runtime: DashcamRuntime; pull: number; deps: HomeDashpalDeps; onOpen(start: SetupStart): void }) {
  const host = useDriveHost();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const pairedConnected = useDashcamSelector(selectConnected);
  const [found, setFound] = useState<Found | null>(null);
  const now = deps.now ?? Date.now;
  const focused = useRef(false);
  const appState = deps.appState ?? AppState;
  const foreground = useRef(appState.currentState == null || appState.currentState === 'active');

  const detectorRef = useRef<Detector | null>(null);
  useEffect(() => {
    const adapter = deps.adapter ?? defaultPermissionsAdapter();
    const detector = createDetector({
      now,
      btOptIn: () => runtime.state().btOptIn,
      bluetoothReady: async () => (await adapter.bluetooth()) === 'granted',
      isBusy: () => host.isBusy(),
      onHome: () => focused.current && foreground.current,
      speedMph: deps.speedMph ?? defaultSpeedMph,
      setupOpen: isSetupOpen,
      paired: () => {
        const l = runtime.state().link;
        return l.paired ? { peripheralId: l.paired.peripheralId, name: l.paired.name, unknownPhone: l.repairCause === 'unknown_phone' } : null;
      },
      pairedConnected: () => runtime.state().link.lifecycle === 'connected',
      snoozes: async () => (await settings.get<Record<string, number>>(SNOOZES_KEY)) ?? {},
      scan: async (o) => {
        const t = runtime.transport();
        if (!t) throw new Error('no Bluetooth transport');
        return t.scan({ services: [...o.services], seconds: o.seconds, onHit: o.onHit });
      },
      sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    });
    detectorRef.current = detector;
    return () => {
      void detector.abort();
      if (detectorRef.current === detector) detectorRef.current = null;
    };
    // `now` and the injected deps are fixed for the slot's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, host, settings]);

  const check = useCallback((pulled = false) => {
    const detector = detectorRef.current;
    if (!detector) return;
    void detector.check({ pull: pulled }).then((r) => {
      // The card stays until a scan no longer hears that DashPal ready to pair.
      if (r.kind === 'found' && !host.isBusy()) setFound(r.found);
      else if (r.kind === 'none') setFound(null);
    });
  }, [host]);

  // Home in view: look; Home left: stop.
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      check();
      return () => {
        focused.current = false;
        void detectorRef.current?.abort();
      };
    }, [check])
  );

  // RoadWise back in front with Home showing: look; leaving the front: stop.
  useEffect(() => {
    const sub = appState.addEventListener('change', (s) => {
      foreground.current = s === 'active';
      if (s === 'active') {
        if (focused.current) check();
      } else void detectorRef.current?.abort();
    });
    return () => sub.remove();
  }, [appState, check]);

  // Pull to refresh.
  const lastPull = useRef(pull);
  useEffect(() => {
    if (pull === lastPull.current) return;
    lastPull.current = pull;
    check(true);
  }, [pull, check]);

  // A drive starting drops the card and any scan.
  useEffect(
    () =>
      host.subscribe((s) => {
        if (!isBusyStatus(s.status)) return;
        setFound(null);
        void detectorRef.current?.abort();
      }),
    [host]
  );

  const notNow = async (f: Found) => {
    setFound(null);
    const map = (await settings.get<Record<string, number>>(SNOOZES_KEY).catch(() => null)) ?? {};
    await settings.set(SNOOZES_KEY, snoozed(map, f.id, now())).catch(() => {});
  };

  const open = (f: Found) => {
    setFound(null);
    onOpen(f.kind === 'again' ? { again: true } : { target: { peripheralId: f.id, name: f.name, adv: f.adv } });
  };

  // Nothing else is offered while the paired DashPal is connected.
  if (!found || pairedConnected) return null;
  return <PairCard kind={found.kind} name={found.name} onOpen={() => open(found)} onNotNow={() => void notNow(found)} />;
}

async function defaultSpeedMph(): Promise<number | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: expo-location
  const { currentSpeedMps } = require('@/features/drive/movingCheck') as typeof import('@/features/drive/movingCheck');
  const mps = await currentSpeedMps();
  return mps === null ? null : mpsToMph(mps);
}

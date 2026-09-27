// The opt-in as the A10 step and the settings screen use it: who may have it, whether it is on, and the two actions.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { readFlag } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries';
import { recordConsent } from '@/data/supabase/profile';
import { useSession } from '@/data/supabase/session';

import { cameraEligibility, readCameraOptIn, turnCameraOff, turnCameraOn, type CameraEligibility, type OptInDeps } from './optIn';

export interface CameraBetaDeps {
  /** the remote flag; default: the stored `camera_beta`, off when never fetched */
  readCameraBeta?: () => Promise<boolean>;
  recordConsent?: OptInDeps['recordConsent'];
}

export interface CameraBeta {
  /** null while loading */
  eligibility: CameraEligibility | null;
  on: boolean | null;
  busy: boolean;
  failed: boolean;
  turnOn(): Promise<boolean>;
  turnOff(): Promise<boolean>;
}

export function useCameraBeta(ageBand: string | null | undefined, deps: CameraBetaDeps = {}): CameraBeta {
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const { session } = useSession();
  const uid = session?.user.id ?? null;
  const [flag, setFlag] = useState<boolean | null>(null);
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const readBeta = deps.readCameraBeta;
  const record = deps.recordConsent ?? recordConsent;

  useEffect(() => {
    let live = true;
    void (async () => {
      const [f, o] = await Promise.all([
        (readBeta ?? (() => readFlag(db, 'camera_beta', false)))().catch(() => false),
        readCameraOptIn(settings, uid),
      ]);
      if (!live) return;
      setFlag(f);
      setOn(o);
    })();
    return () => {
      live = false;
    };
  }, [db, settings, uid, readBeta]);

  const eligibility = flag === null ? null : cameraEligibility(ageBand, flag);

  const turnOn = useCallback(async () => {
    if (uid === null || busy || eligibility !== 'ok') return false;
    setBusy(true);
    setFailed(false);
    try {
      await turnCameraOn({ settings, recordConsent: record }, uid);
      setOn(true);
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setBusy(false);
    }
  }, [uid, busy, eligibility, settings, record]);

  const turnOff = useCallback(async () => {
    if (uid === null || busy) return false;
    setBusy(true);
    setFailed(false);
    try {
      await turnCameraOff(settings, uid);
      setOn(false);
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setBusy(false);
    }
  }, [uid, busy, settings]);

  return { eligibility, on, busy, failed, turnOn, turnOff };
}

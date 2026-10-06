// The setup screen's state: runs the bridge's setup session, mirrors its view, and on success writes
// `dms.calibratedAt` and turns DMS on. Cancelled on unmount (the camera stops with the session).
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DmsSetupSession, DmsSetupView, SetupResult } from '@/core/dms';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';

import { cameraBridge } from './runtime';
import { DMS_SETTING_QUERY_KEY, writeDmsCalibrated } from './dmsSettings';

export type SetupPhase =
  | { kind: 'intro' }
  | { kind: 'running'; view: DmsSetupView | null }
  | { kind: 'done'; mirrors: number }
  | { kind: 'failed'; reason: Exclude<SetupResult, { ok: true }>['reason'] | 'unavailable' | 'save_failed' };

export interface DmsSetupDeps {
  /** default: the launch's bridge (`cameraBridge()`) */
  startSetup?: (onChange: (v: DmsSetupView) => void) => Promise<DmsSetupSession | null>;
}

export function useDmsSetup(deps: DmsSetupDeps = {}): { phase: SetupPhase; start(): void; cancel(): void } {
  const db = useDb();
  const qc = useQueryClient();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const [phase, setPhase] = useState<SetupPhase>({ kind: 'intro' });
  const session = useRef<DmsSetupSession | null>(null);
  const live = useRef(true);
  const startSetup = deps.startSetup;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      session.current?.cancel();
      session.current = null;
    };
  }, []);

  const start = useCallback(() => {
    if (session.current !== null) return;
    setPhase({ kind: 'running', view: null });
    void (async () => {
      const begin = startSetup ?? ((onChange: (v: DmsSetupView) => void) => cameraBridge()?.startSetup(onChange) ?? Promise.resolve(null));
      const s = await begin((v) => {
        if (live.current) setPhase((p) => (p.kind === 'running' ? { kind: 'running', view: v } : p));
      });
      if (s === null) {
        if (live.current) setPhase({ kind: 'failed', reason: 'unavailable' });
        return;
      }
      session.current = s;
      const result = await s.run();
      session.current = null;
      if (!live.current) return;
      if (!result.ok) {
        setPhase({ kind: 'failed', reason: result.reason });
        return;
      }
      try {
        await writeDmsCalibrated(settings, result.savedAtMs);
        void qc.invalidateQueries({ queryKey: DMS_SETTING_QUERY_KEY });
        if (live.current) setPhase({ kind: 'done', mirrors: result.mirrors });
      } catch {
        if (live.current) setPhase({ kind: 'failed', reason: 'save_failed' });
      }
    })();
  }, [startSetup, settings, qc]);

  const cancel = useCallback(() => {
    session.current?.cancel();
    session.current = null;
  }, []);

  return { phase, start, cancel };
}

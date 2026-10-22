/**
 * `update_profile` for one field at a time, shown as made while it saves: the screen reads
 * `value(field, serverValue)`, which is the value being saved until the summary refetches, and
 * falls back to the server's on a failure. Saves run one after another in tap order (a quick second
 * toggle waits for the first instead of being dropped), so the last tap wins. A failed save falls
 * back only when no newer save of the same field was made since, and its error stands until the
 * next tap.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import { invalidateAfterWrite } from '@/data/server/invalidate';
import { callRpc } from '@/data/server/rpc';
import type { HeatmapVisibility } from '@/data/server/summary';
import { friendlyError } from '@/features/social/errors';

export interface ProfileFields {
  units: 'mi' | 'km';
  heatmap_visibility: HeatmapVisibility;
  /** What friends can see (Settings › Privacy). */
  share_rating: boolean;
  share_categories: boolean;
  share_achievements: boolean;
  share_stats: boolean;
}

const RPC = 'update_profile';

export function useProfileEdit() {
  const qc = useQueryClient();
  const [shown, setShown] = useState<Partial<ProfileFields>>({});
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The saves in tap order: each starts once the one before has settled.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // The newest save of each field, so an older one that fails leaves a newer optimistic value alone.
  const seq = useRef<Partial<Record<keyof ProfileFields, number>>>({});

  const save = useCallback(
    async <K extends keyof ProfileFields>(field: K, next: ProfileFields[K]): Promise<boolean> => {
      const mine = (seq.current[field] ?? 0) + 1;
      seq.current[field] = mine;
      setShown((s) => ({ ...s, [field]: next }));
      setError(null);
      setPending((n) => n + 1);
      const write = async (): Promise<boolean> => {
        try {
          await callRpc<unknown>(RPC, { [`p_${field}`]: next });
          await invalidateAfterWrite(qc, RPC);
          return true;
        } catch (e) {
          setError(friendlyError(e));
          return false;
        }
      };
      const p = queue.current.then(write);
      queue.current = p;
      const ok = await p;
      setPending((n) => n - 1);
      if (!ok && seq.current[field] === mine) {
        setShown((s) => {
          const rest = { ...s };
          delete rest[field];
          return rest;
        });
      }
      return ok;
    },
    [qc]
  );

  const value = <K extends keyof ProfileFields>(field: K, server: ProfileFields[K] | null | undefined) =>
    (shown[field] as ProfileFields[K] | undefined) ?? server ?? null;

  const clearError = useCallback(() => setError(null), []);

  return { save, value, saving: pending > 0, error, clearError };
}

/**
 * The family hooks. One read (`family_snapshot`) under `['family', uid]`, polled every 30 s only
 * while the Family screen is focused AND the app is in front (never in the background, no
 * Realtime); every change is a mutation that reads the snapshot again. The snapshot's own answer
 * about sharing is written to the phone (`family.sharing`), which the location poster reads before
 * it ever posts.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';

import type { AppStateLike } from '@/data/foreground';
import { useDataSource } from '@/data/queries';
import { useSession } from '@/data/supabase/session';

import { defaultFamilyApi, type FamilyApi, type FamilySnapshot, type PlaceInput } from './api';
import { writeSharingRecord } from './location';

export const FAMILY_POLL_MS = 30_000;
export const familyKey = (uid: string) => ['family', uid] as const;

export interface FamilyDeps {
  api?: FamilyApi;
  appState?: AppStateLike;
}

function useUid(): string | null {
  return useSession().session?.user.id ?? null;
}

/** Whether the app is in front, following AppState. */
function useInFront(appState: AppStateLike): boolean {
  const [front, setFront] = useState(appState.currentState !== 'background' && appState.currentState !== 'inactive');
  useEffect(() => {
    const sub = appState.addEventListener('change', (s) => setFront(s === 'active'));
    return () => sub.remove();
  }, [appState]);
  return front;
}

/**
 * The caller's family. `poll`: the screen is focused (the map and the list read fresh locations);
 * the poll also stops whenever the app leaves the front.
 */
export function useFamily(deps: FamilyDeps & { poll?: boolean } = {}): UseQueryResult<FamilySnapshot> {
  const { db } = useDataSource();
  const uid = useUid();
  const api = deps.api ?? defaultFamilyApi;
  const front = useInFront(deps.appState ?? AppState);
  const key = useMemo(() => familyKey(uid ?? ''), [uid]);
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const snapshot = await api.fetchSnapshot();
      await writeSharingRecord(db, uid as string, snapshot.family?.mySharing ?? false).catch(() => undefined);
      return snapshot;
    },
    enabled: uid !== null,
    staleTime: FAMILY_POLL_MS,
    refetchInterval: deps.poll === true && front ? FAMILY_POLL_MS : false,
    refetchIntervalInBackground: false,
  });
  return query;
}

/** One family change: the call (then `after`, best effort), then the snapshot read again. */
function useFamilyMutation<A, R>(fn: (arg: A) => Promise<R>, after?: (arg: A) => Promise<void>) {
  const client = useQueryClient();
  return useMutation<R, unknown, A>({
    mutationFn: async (arg) => {
      const out = await fn(arg);
      if (after) await after(arg).catch(() => undefined);
      return out;
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['family'] }).catch(() => undefined),
  });
}

/** Every family change. */
export function useFamilyActions(deps: FamilyDeps = {}) {
  const { db } = useDataSource();
  const uid = useUid();
  const api = deps.api ?? defaultFamilyApi;
  const record = async (on: boolean) => {
    if (uid !== null) await writeSharingRecord(db, uid, on);
  };
  return {
    create: useFamilyMutation((name: string) => api.createFamily(name)),
    join: useFamilyMutation((code: string) => api.joinFamily(code)),
    leave: useFamilyMutation(
      () => api.leaveFamily(),
      () => record(false)
    ),
    remove: useFamilyMutation((userId: string) => api.removeMember(userId)),
    rotate: useFamilyMutation(() => api.rotateCode()),
    setSharing: useFamilyMutation(
      (on: boolean) => api.setSharing(on),
      (on) => record(on)
    ),
    savePlace: useFamilyMutation((place: PlaceInput) => api.savePlace(place)),
    deletePlace: useFamilyMutation((id: string) => api.deletePlace(id)),
  };
}

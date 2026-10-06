/**
 * The driver's own routes for the heat map, from this phone's drives (plan §10:
 * `useRoutePolylines(sinceMs)` in `@/data/queries`, already privacy-trimmed). Read through the
 * module namespace so this area builds before that hook lands; until then the map is empty.
 */
import type { UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';

import * as queries from '@/data/queries';

type RoutePolylinesHook = (sinceMs: number | null) => UseQueryResult<string[]>;

const useRoutePolylines = (queries as unknown as { useRoutePolylines?: RoutePolylinesHook }).useRoutePolylines;

/** The heat map covers the same 90 days the server's `get_heatmap` does. */
export const HEATMAP_DAYS = 90;

type OwnRoutes = { data: string[] | undefined; loading: boolean; error: boolean };

function useFromDrives(): OwnRoutes {
  // Fixed for the screen's life, so the query key doesn't change every render.
  const [since] = useState(() => Date.now() - HEATMAP_DAYS * 86_400_000);
  const q = (useRoutePolylines as RoutePolylinesHook)(since);
  return { data: q.data, loading: q.isLoading, error: q.isError };
}

function useNoRoutesYet(): OwnRoutes {
  return { data: [], loading: false, error: false };
}

/** Chosen once, when the module loads, so every render calls the same hooks. */
export const useOwnRoutes: () => OwnRoutes = useRoutePolylines ? useFromDrives : useNoRoutesYet;

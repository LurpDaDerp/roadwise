/**
 * The recap's commute line for a drive (`commuteCompare`): the scored drives from `COMPARE_DAYS`
 * before it on (one read, its window start rounded down to the hour so the query keeps its key
 * across the recap's re-renders and drives near each other share it) and the saved places. Null
 * while either is loading.
 */
import { useMemo } from 'react';

import { useScoredDrives } from '@/data/queries/analytics';
import { usePlaces } from '@/features/places/usePlaces';

import { commuteCompare, COMPARE_DAYS, type CommuteCompare } from './commuteCompare';
import type { LocalDrive } from './model';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function useCommuteCompare(drive: LocalDrive): CommuteCompare | null {
  const since = Math.floor((drive.startedAt - COMPARE_DAYS * DAY_MS) / HOUR_MS) * HOUR_MS;
  const q = useScoredDrives(since);
  // Another window's drives held over while this one loads say nothing about this drive's usual.
  const others = q.isPlaceholderData ? undefined : q.data;
  const { places } = usePlaces();
  return useMemo(() => (others === undefined || places === undefined ? null : commuteCompare(drive, others, places)), [drive, others, places]);
}

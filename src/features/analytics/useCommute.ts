/**
 * The "Your commute" card's rows: the Analytics tab's drives (every scored drive not archived)
 * matched to the saved places (`usePlaces`), and the scores of just each leg's newest drives
 * (`useDriveScores`, one events read). Cheap on the tab's first render: a filter over the drives
 * and a few legs, recomputed when the drives, the places or the hour change.
 */
import { useMemo } from 'react';

import type { LocalDrive } from '@/data/queries/rows';
import { useDataSource } from '@/data/queries/context';
import { useDriveScores } from '@/features/drives/useDriveScores';
import { usePlaces } from '@/features/places/usePlaces';

import { commuteLegs, commuteRows, scoreReadDrives, type CommuteRow } from './commuteModel';
import { windowStart } from './model';

export function useCommute(drives: readonly LocalDrive[]): CommuteRow[] {
  const { now } = useDataSource();
  // The end of the current hour, as the trend reads it: the windows move once an hour, not every render.
  const hourEnd = windowStart(now(), 0) + 3_599_999;
  const { places } = usePlaces();
  const legs = useMemo(() => (places === undefined || places.length === 0 ? [] : commuteLegs(drives, places, hourEnd)), [drives, places, hourEnd]);
  // Only each leg's newest drives are scored (all its score and change read), so the events read stays small and keeps its key as old drives age out.
  const scoreDrives = useMemo(() => scoreReadDrives(legs), [legs]);
  const scores = useDriveScores(scoreDrives);
  return useMemo(() => commuteRows(legs, scores), [legs, scores]);
}

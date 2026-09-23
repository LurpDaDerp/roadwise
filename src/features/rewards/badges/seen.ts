/**
 * Which earned badges this phone has already shown, per account (settings `rewards.seenBadges`), so
 * a seal thumps once — the first time its badge is seen — and never again.
 *
 * The stored value names its uid: another account's list reads as empty, so one account's seen
 * badges never silence the next account's first sight of its own.
 */
import { useEffect, useState } from 'react';

import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries';

export const SEEN_BADGES_KEY = 'rewards.seenBadges';

interface Stored {
  uid: string;
  ids: string[];
}

const isStored = (v: unknown): v is Stored =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Stored).uid === 'string' &&
  Array.isArray((v as Stored).ids) &&
  (v as Stored).ids.every((id) => typeof id === 'string');

export async function readSeenBadges(db: Db, uid: string): Promise<Set<string>> {
  try {
    const stored = await createSettingsRepo(db).get<unknown>(SEEN_BADGES_KEY);
    return isStored(stored) && stored.uid === uid ? new Set(stored.ids) : new Set();
  } catch {
    // Unreadable: treat as nothing seen. The worst case is one extra thump.
    return new Set();
  }
}

export async function markBadgesSeen(db: Db, uid: string, ids: readonly string[]): Promise<void> {
  const seen = await readSeenBadges(db, uid);
  const before = seen.size;
  for (const id of ids) seen.add(id);
  if (seen.size === before) return;
  await createSettingsRepo(db).set(SEEN_BADGES_KEY, { uid, ids: [...seen].sort() } satisfies Stored);
}

/**
 * The earned badges this screen is the first to show: `null` until the seen list is read, then a
 * set fixed for the life of the screen (so a seal that started its thump is never cut short), and
 * the earned ids are recorded as seen.
 */
export function useFreshBadges(uid: string | null, earnedIds: readonly string[] | undefined): ReadonlySet<string> | null {
  const db = useDb();
  const [fresh, setFresh] = useState<ReadonlySet<string> | null>(null);
  const ready = uid !== null && earnedIds !== undefined;
  const key = earnedIds ? [...earnedIds].sort().join(',') : '';

  useEffect(() => {
    if (uid === null || !ready || fresh !== null) return;
    let live = true;
    const ids = key === '' ? [] : key.split(',');
    void readSeenBadges(db, uid).then((seen) => {
      if (!live) return;
      setFresh(new Set(ids.filter((id) => !seen.has(id))));
      markBadgesSeen(db, uid, ids).catch(() => undefined);
    });
    return () => {
      live = false;
    };
  }, [db, fresh, key, ready, uid]);

  return fresh;
}

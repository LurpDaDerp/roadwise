/**
 * After a deletion: this phone keeps nothing of the account either. The handover's own wipe
 * (`wipeDevice`: every local table, the drive summaries still scheduled, then the traces on disk),
 * run straight after the sign-out rather than at the next sign-in.
 */
import { wipeDevice } from '@/boot/device';
import type { Db } from '@/data/db/driver';
import { TRACES_DIRECTORY } from '@/data/sync/traceFs';

interface TraceDirFs {
  Paths: { document: unknown };
  Directory: new (...parts: never[]) => { delete(options?: { idempotent?: boolean }): void };
}

/** The traces directory, removed whole (the next drive recreates it), as the trace writer does. */
export async function clearLocalTraces(load?: () => Promise<TraceDirFs>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
  const { Directory, Paths } = load ? await load() : (require('expo-file-system') as TraceDirFs);
  new Directory(...([Paths.document, TRACES_DIRECTORY] as never[])).delete({ idempotent: true });
}

export function wipeThisPhone(db: Db): Promise<void> {
  return wipeDevice(db, { traces: { clear: () => clearLocalTraces() } });
}

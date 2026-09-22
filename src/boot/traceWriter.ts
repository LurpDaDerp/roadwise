import { TRACES_DIRECTORY } from '@/data/sync/traceFs';

import { gzip } from './gzip';

/** The finalizer's `fs` (`FinalizeDeps.fs`): one gzip file per trip, replacing any there. */
export interface TraceWriter {
  writeGzip(path: string, bytes: Uint8Array): Promise<void>;
  /**
   * Remove every trace on disk, directory and all, for when the device changes hands
   * (`src/boot/device.ts`). The next write recreates the directory, so nothing has to put it back.
   */
  clear(): Promise<void>;
}

/** The slice of `expo-file-system` the writer touches, or a test's stand-in for it. */
export interface ExpoWriterFileSystemLike {
  Paths: { document: unknown };
  Directory: new (...uris: never[]) => {
    /** The directory as a `file://` URI — what drive-sense's `excludeFromBackup` takes. */
    readonly uri: string;
    create(options?: { intermediates?: boolean; idempotent?: boolean }): void;
    delete(options?: { idempotent?: boolean }): void;
  };
  File: new (...uris: never[]) => { write(content: Uint8Array): void };
}

/** drive-sense's `excludeFromBackup`: iOS sets the attribute, Android resolves (plan R4). */
async function driveSenseExclude(uri: string): Promise<void> {
  const { default: DriveSense } = await import('@drive-sense');
  await DriveSense.excludeFromBackup(uri);
}

function warn(error: unknown, context: string): void {
  if (__DEV__) console.warn(`[traces] ${context}:`, error);
}

/**
 * The other half of `createExpoTraceFs`: the finalizer writes here, the sync runner reads and
 * deletes from the same directory by the same relative name, so a path never leaves the traces
 * folder. `expo-file-system` is imported lazily for the same reason the reader imports it so —
 * a test that wants the type must not pull a native module into its process.
 *
 * **Backup exclusion (plan R4, D2).** A trace is the most identifying thing the app stores — every
 * second of a drive — and an iCloud or Finder backup would keep it past an uninstall or an in-app
 * delete, on a family phone often in a parent's account. So the directory is created and
 * excluded **on every writer creation** (each launch): idempotent, and it is what reaches an
 * install whose directory predates this build. `clear()` removes the directory with its
 * attribute, so the write that recreates it excludes it again before the trace goes in. An
 * exclusion that rejects (drive-sense `E_NOT_FOUND`/`E_IO`, or no native module) is reported and
 * ignored: failing to write a drive would be worse than a trace in a backup.
 */
export async function createExpoTraceWriter(
  directory: string = TRACES_DIRECTORY,
  load?: () => Promise<ExpoWriterFileSystemLike>,
  excludeFromBackup: (uri: string) => Promise<void> = driveSenseExclude,
  onError: (error: unknown, context: string) => void = warn
): Promise<TraceWriter> {
  const { Directory, File, Paths } = await (load
    ? load()
    : (import('expo-file-system') as unknown as Promise<ExpoWriterFileSystemLike>));

  /** The directory exists and carries the attribute, as far as this writer knows. */
  let excluded = false;

  /** Create the directory (idempotent) and return it. */
  function makeDirectory() {
    const dir = new Directory(...([Paths.document, directory] as never[]));
    dir.create({ intermediates: true, idempotent: true });
    return dir;
  }

  async function exclude(uri: string): Promise<void> {
    try {
      await excludeFromBackup(uri);
      excluded = true;
    } catch (error) {
      onError(error, 'exclude traces from backup');
    }
  }

  // At creation the exclusion is started, not awaited (review D2 m3): the writer is made on the
  // launch path, background wakes included, and a native call that hung must not hold it. The
  // write below awaits its own exclusion if this one has not landed by then.
  void exclude(makeDirectory().uri);

  return {
    async writeGzip(path: string, bytes: Uint8Array): Promise<void> {
      const dir = makeDirectory();
      if (!excluded) await exclude(dir.uri);
      new File(...([Paths.document, directory, path] as never[])).write(gzip(bytes));
    },

    async clear(): Promise<void> {
      // Idempotent: a directory that was never written is already in the state this asks for.
      new Directory(...([Paths.document, directory] as never[])).delete({ idempotent: true });
      excluded = false;
    },
  };
}

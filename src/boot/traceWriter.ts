import { TRACES_DIRECTORY } from '@/data/sync/traceFs';

import { gzipStored } from './gzip';

/** The finalizer's `fs` (`FinalizeDeps.fs`): one gzip file per trip, replacing any there. */
export interface TraceWriter {
  writeGzip(path: string, bytes: Uint8Array): Promise<void>;
}

/** The slice of `expo-file-system` the writer touches, or a test's stand-in for it. */
export interface ExpoWriterFileSystemLike {
  Paths: { document: unknown };
  Directory: new (...uris: never[]) => {
    create(options?: { intermediates?: boolean; idempotent?: boolean }): void;
  };
  File: new (...uris: never[]) => { write(content: Uint8Array): void };
}

/**
 * The other half of `createExpoTraceFs`: the finalizer writes here, the sync runner reads and
 * deletes from the same directory by the same relative name, so a path never leaves the traces
 * folder. `expo-file-system` is imported lazily for the same reason the reader imports it so —
 * a test that wants the type must not pull a native module into its process.
 */
export async function createExpoTraceWriter(
  directory: string = TRACES_DIRECTORY,
  load?: () => Promise<ExpoWriterFileSystemLike>
): Promise<TraceWriter> {
  const { Directory, File, Paths } = await (load
    ? load()
    : (import('expo-file-system') as unknown as Promise<ExpoWriterFileSystemLike>));

  return {
    async writeGzip(path: string, bytes: Uint8Array): Promise<void> {
      // Idempotent: the directory is created once and every later call finds it there.
      new Directory(...([Paths.document, directory] as never[])).create({
        intermediates: true,
        idempotent: true,
      });
      new File(...([Paths.document, directory, path] as never[])).write(gzipStored(bytes));
    },
  };
}

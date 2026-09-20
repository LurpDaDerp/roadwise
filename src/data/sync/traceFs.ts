import type { TraceBody, TraceFs } from '@/data/sync/runner';

/**
 * The device's traces directory, as a `TraceFs` for the sync runner.
 *
 * The finalizer writes `<clientTripId>.bin.gz` here (its `fs.writeGzip`); the runner reads it
 * back, hands the bytes to Storage and deletes the file once the object is up. Paths are always
 * relative to this directory — the runner never sees an absolute URI, and never builds the
 * Storage object key from one.
 *
 * `expo-file-system` is imported lazily, the way `createExpoDb` imports `expo-sqlite`: a test
 * that only wants the `TraceFs` type must not pull a native module into its process.
 */
export const TRACES_DIRECTORY = 'traces';

/** `expo-file-system`'s `File`/`Paths`, or a test's stand-in for them. */
export interface ExpoFileSystemLike {
  Paths: { document: unknown };
  File: new (
    ...uris: never[]
  ) => {
    exists: boolean;
    bytes(): Promise<Uint8Array>;
    delete(): void;
  };
}

export async function createExpoTraceFs(
  directory: string = TRACES_DIRECTORY,
  load?: () => Promise<ExpoFileSystemLike>
): Promise<TraceFs> {
  const { File, Paths } = await (load
    ? load()
    : (import('expo-file-system') as unknown as Promise<ExpoFileSystemLike>));
  const at = (path: string) => new File(...([Paths.document, directory, path] as never[]));

  return {
    async exists(path: string): Promise<boolean> {
      return at(path).exists;
    },

    async read(path: string): Promise<TraceBody> {
      return at(path).bytes();
    },

    async remove(path: string): Promise<void> {
      const file = at(path);
      // `delete()` throws on a file that is not there; gone is the outcome we wanted anyway.
      if (file.exists) file.delete();
    },
  };
}

/**
 * The image files a share leaves behind, and their removal. A drive's share card (and a Wrapped's)
 * is captured to a temporary PNG (`react-native-view-shot`, in tmp/ReactNative on iPhone), and its
 * map is a snapshot PNG (`react-native-maps`, in Documents on iPhone, in the cache on Android). The
 * card draws the whole route, the lead-in from where the drive began included, so each file is
 * deleted as soon as it is done with, and a wipe of the phone (Delete account, a sign-out, another
 * driver signing in) sweeps up any a crash left. Every step is best effort: a failure here never
 * stops a share or a wipe. The data export's folder (`export` in the cache) is swept with them.
 */

interface FsEntry {
  name: string;
  exists: boolean;
  delete(): void;
}

interface FsDirectory extends FsEntry {
  uri: string;
  parentDirectory: FsDirectory;
  list(): FsEntry[];
}

/** `expo-file-system`'s `File`, `Directory` and `Paths`, or a test's stand-in. */
export interface ShareFsLike {
  Paths: { cache: FsDirectory; document: FsDirectory };
  File: new (...parts: (string | FsDirectory)[]) => FsEntry;
  Directory: new (...parts: (string | FsDirectory)[]) => FsDirectory;
}

let fsForTests: ShareFsLike | null | undefined;

/** Tests: stand in for `expo-file-system` (null: no module); undefined goes back to the real one. */
export function setShareFsForTests(fs: ShareFsLike | null | undefined): void {
  fsForTests = fs;
}

function loadFs(): ShareFsLike | null {
  if (fsForTests !== undefined) return fsForTests;
  try {
    // A deferred require: nothing native loads until a share or a wipe needs it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
    return require('expo-file-system') as ShareFsLike;
  } catch {
    return null;
  }
}

/** A captured image's location as a file URI: view-shot answers a bare path on iPhone. */
export const toFileUri = (uriOrPath: string): string => (uriOrPath.startsWith('/') ? `file://${uriOrPath}` : uriOrPath);

/** Deletes one share image (a card capture or a map snapshot). Never throws. */
export function removeShareImage(uriOrPath: string | null | undefined): void {
  if (!uriOrPath || uriOrPath.startsWith('data:')) return;
  try {
    const fs = loadFs();
    if (!fs) return;
    const f = new fs.File(toFileUri(uriOrPath));
    if (f.exists) f.delete();
  } catch {
    // A leftover is the next wipe's (or the OS's) to clear.
  }
}

/** The files to sweep in a folder: each one `pick` matches. */
function sweep(dir: () => FsDirectory, pick: (name: string) => boolean): void {
  try {
    const d = dir();
    if (!d.exists) return;
    for (const entry of d.list()) {
      try {
        if (pick(entry.name)) entry.delete();
      } catch {
        // the next file
      }
    }
  } catch {
    // no such folder on this platform
  }
}

const IMAGE = /\.(png|jpe?g)$/i;

/**
 * Deletes every share image a crash or a closed app left on the phone: card captures, map snapshots
 * and the data export's folder. Never throws.
 */
export function sweepShareImages(): void {
  const fs = loadFs();
  if (!fs) return;
  const { Paths, Directory } = fs;
  // iPhone: view-shot's captures (tmp/ReactNative, beside Documents) and the map snapshots in Documents.
  sweep(() => new Directory(Paths.document.parentDirectory, 'tmp', 'ReactNative'), (n) => IMAGE.test(n));
  sweep(() => Paths.document, (n) => n.startsWith('snapshot-') && IMAGE.test(n));
  // Android: both land in the cache.
  sweep(() => Paths.cache, (n) => (n.startsWith('ReactNative-snapshot-image') || n.startsWith('AirMapSnapshot')) && IMAGE.test(n));
  // The data export deletes its own file; one a crash left goes here.
  sweep(() => new Directory(Paths.cache, 'export'), () => true);
}

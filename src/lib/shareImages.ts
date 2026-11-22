/**
 * The image files a share leaves behind, and their removal. A drive's share card (and a Wrapped's)
 * is captured to a temporary PNG (`react-native-view-shot`, in tmp/ReactNative on iPhone), and its
 * map is a snapshot PNG (`react-native-maps`, in Documents on iPhone, in the cache on Android). The
 * card draws the whole route, the lead-in from where the drive began included, so each file is
 * deleted as soon as it is done with, and a wipe of the phone (Delete account, a sign-out, another
 * driver signing in) sweeps up any a crash left. Every step is best effort: a failure here never
 * stops a share or a wipe. The data export's folder (`export` in the cache) is swept with them.
 *
 * Android's share sheet answers as soon as it is up (or a target is picked), while the app picked
 * may still be reading the file, so there a shared file (a card, a Wrapped, the data export, the
 * Permit log's PDF) is not deleted when the sheet answers. `sweepStaleShareFiles` deletes each one
 * once it is `SHARE_FILE_MAX_AGE_MS` old, at launch and on every return to the front.
 */
import { Platform } from 'react-native';

interface FsEntry {
  name: string;
  exists: boolean;
  /** When the file was last written, epoch ms (`expo-file-system`); absent or null when unknown. */
  modificationTime?: number | null;
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

/** The files to sweep in a folder: each one whose name `pick` matches. */
function sweep(dir: () => FsDirectory, pick: (name: string) => boolean): void {
  sweepWhere(dir, (entry) => pick(entry.name));
}

const IMAGE = /\.(png|jpe?g)$/i;

/** Android: view-shot's card captures and the map snapshots, both straight in the cache. */
const androidCapture = (n: string) => (n.startsWith('ReactNative-snapshot-image') || n.startsWith('AirMapSnapshot')) && IMAGE.test(n);
/** expo-print's PDFs (the Permit log), in `Print` in the cache on both platforms. */
const PRINT_DIRECTORY = 'Print';
const PDF = /\.pdf$/i;

/**
 * Deletes every share image a crash or a closed app left on the phone: card captures, map snapshots,
 * the data export's folder and the Permit log's PDFs. Never throws.
 */
export function sweepShareImages(): void {
  const fs = loadFs();
  if (!fs) return;
  const { Paths, Directory } = fs;
  // iPhone: view-shot's captures (tmp/ReactNative, beside Documents) and the map snapshots in Documents.
  sweep(() => new Directory(Paths.document.parentDirectory, 'tmp', 'ReactNative'), (n) => IMAGE.test(n));
  sweep(() => Paths.document, (n) => n.startsWith('snapshot-') && IMAGE.test(n));
  // Android: both land in the cache.
  sweep(() => Paths.cache, androidCapture);
  // The data export deletes its own file (on iPhone; Android's goes with the stale sweep); one a crash left goes here.
  sweep(() => new Directory(Paths.cache, 'export'), () => true);
  // The Permit log's PDF: Android's waits for the stale sweep, and on iPhone one is left when the app
  // is killed with its share sheet still open. A wipe takes either at once.
  sweep(() => new Directory(Paths.cache, PRINT_DIRECTORY), (n) => PDF.test(n));
}

/**
 * How old an Android share file is before the sweep takes it: the app it went to has long finished
 * reading it by then (a mail draft or a message keeps its own copy).
 */
export const SHARE_FILE_MAX_AGE_MS = 10 * 60_000;

/**
 * Android: deletes every shared file at least `maxAgeMs` old: card and Wrapped captures, map
 * snapshots, the data export and the Permit log's PDF. A file whose age is unknown is left for the
 * next wipe. Nothing on iPhone, where each file goes as soon as its sheet closes. Never throws.
 */
export function sweepStaleShareFiles(now: number = Date.now(), maxAgeMs: number = SHARE_FILE_MAX_AGE_MS, os: string = Platform.OS): void {
  if (os !== 'android') return;
  const fs = loadFs();
  if (!fs) return;
  const { Paths, Directory } = fs;
  const old = (entry: FsEntry): boolean => {
    const t = entry.modificationTime;
    return typeof t === 'number' && t > 0 && now - t >= maxAgeMs;
  };
  sweepWhere(() => Paths.cache, (e) => androidCapture(e.name) && old(e));
  sweepWhere(() => new Directory(Paths.cache, 'export'), old);
  sweepWhere(() => new Directory(Paths.cache, PRINT_DIRECTORY), (e) => PDF.test(e.name) && old(e));
}

/** The files to sweep in a folder: each entry `pick` takes. */
function sweepWhere(dir: () => FsDirectory, pick: (entry: FsEntry) => boolean): void {
  try {
    const d = dir();
    if (!d.exists) return;
    for (const entry of d.list()) {
      try {
        if (pick(entry)) entry.delete();
      } catch {
        // the next file
      }
    }
  } catch {
    // no such folder
  }
}

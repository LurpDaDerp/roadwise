/**
 * The one place an export leaves the phone (H14): the JSON is written to `export/<name>` in the
 * cache directory and handed to the system share sheet as a file (Save to Files or Drive, Mail,
 * AirDrop or Nearby Share).
 *
 * - **iOS:** React Native's `Share` with the file. The file is deleted on every path (shared,
 *   dismissed or failed), so no copy of the data outlives the sheet.
 * - **Android:** React Native's `Share` can't carry a file, so expo-sharing's sheet takes it. Its
 *   answer comes as soon as a target is picked, while that app may still be reading the file, so the
 *   file is deleted only when the share fails; otherwise it goes with the sweep of shared files 10
 *   minutes old (`sweepStaleShareFiles`, at launch and on each return to the front) or the next
 *   wipe. Android's sheet says nothing about a dismissal.
 *
 * Nothing is logged: the file is the driver's own data.
 */
import { Platform, Share } from 'react-native';

export type ExportShareOutcome = 'shared' | 'dismissed' | 'failed';

interface FileLike {
  uri: string;
  exists: boolean;
  create(options?: { intermediates?: boolean; overwrite?: boolean }): void;
  write(content: string): void;
  delete(): void;
}

/** `expo-file-system`'s `File` and `Paths`, or a test's stand-in. */
export interface ExportFsLike {
  Paths: { cache: unknown };
  File: new (...parts: never[]) => FileLike;
}

export interface ExportShareDeps {
  platform?: string;
  /** iOS: React Native's `Share` with the file. */
  share?: (content: { url: string }) => Promise<{ action: string }>;
  /** Android: expo-sharing's sheet with the file. */
  shareFile?: (uri: string, options: { mimeType: string; dialogTitle: string }) => Promise<void>;
  loadFs?: () => Promise<ExportFsLike>;
  /** Epoch ms, for the file's date. */
  now?: () => number;
}

const EXPORT_DIRECTORY = 'export';

/** `roadwise-data-2026-09-26.json`, the phone's local date. */
export function exportFileName(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `roadwise-data-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

async function defaultLoadFs(): Promise<ExportFsLike> {
  // A deferred require, as the alert ports load theirs: nothing native until the driver taps.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
  return require('expo-file-system') as ExportFsLike;
}

const defaultShare = (content: { url: string }) => Share.share(content as { url: string; message?: string });

const defaultShareFile = (uri: string, options: { mimeType: string; dialogTitle: string }): Promise<void> =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
  (require('expo-sharing') as typeof import('expo-sharing')).shareAsync(uri, options);

/** The Android sheet's title: the row's own words. */
const DIALOG_TITLE = 'Export my data';

/** Hands `json` to the platform's sheet. Never throws. */
export async function shareExport(json: string, deps: ExportShareDeps = {}): Promise<ExportShareOutcome> {
  const platform = deps.platform ?? Platform.OS;
  const name = exportFileName((deps.now ?? Date.now)());
  let fs: ExportFsLike;
  try {
    fs = await (deps.loadFs ?? defaultLoadFs)();
  } catch {
    return 'failed';
  }

  const android = platform === 'android';
  let file: FileLike | null = null;
  /** Android: a sheet that took the file leaves it for the app picked (the stale sweep deletes it). */
  let keep = false;
  try {
    file = new fs.File(...([fs.Paths.cache, EXPORT_DIRECTORY, name] as never[]));
    file.create({ intermediates: true, overwrite: true });
    file.write(json);
    if (android) {
      await (deps.shareFile ?? defaultShareFile)(file.uri, { mimeType: 'application/json', dialogTitle: DIALOG_TITLE });
      keep = true;
      return 'shared';
    }
    const result = await (deps.share ?? defaultShare)({ url: file.uri });
    return result.action === 'dismissedAction' ? 'dismissed' : 'shared';
  } catch {
    return 'failed';
  } finally {
    try {
      if (!keep && file?.exists) file.delete();
    } catch {
      // A cache file the system couldn't remove is cleared with the cache.
    }
  }
}

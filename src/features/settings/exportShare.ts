/**
 * The one place an export leaves the phone (H14). No new native module (`expo-sharing` would be
 * one), so the two platforms differ, like the share card before it:
 *
 * - **iOS:** the JSON is written to `export/<name>` in the cache directory and handed to the share
 *   sheet as a file (Save to Files, Mail, AirDrop). The file is deleted on every path — shared,
 *   dismissed or failed — so no copy of the data outlives the sheet.
 * - **Android:** React Native's `Share` can't carry a file, and a whole export is too large for a
 *   text share, so the system folder picker is the sheet: the driver chooses a folder and the file
 *   is saved there. Choosing no folder is a dismissal.
 *
 * Nothing is logged: the file is the driver's own data.
 */
import { Platform, Share } from 'react-native';

export type ExportShareOutcome = 'shared' | 'saved' | 'dismissed' | 'failed';

interface FileLike {
  uri: string;
  exists: boolean;
  create(options?: { intermediates?: boolean; overwrite?: boolean }): void;
  write(content: string): void;
  delete(): void;
}

/** `expo-file-system`'s `File`, `Directory` and `Paths`, or a test's stand-in. */
export interface ExportFsLike {
  Paths: { cache: unknown };
  File: new (...parts: never[]) => FileLike;
  Directory: { pickDirectoryAsync(initialUri?: string): Promise<{ createFile(name: string, mimeType: string | null): FileLike }> };
}

export interface ExportShareDeps {
  platform?: string;
  share?: (content: { url: string }) => Promise<{ action: string }>;
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

  if (platform === 'android') {
    let directory: { createFile(name: string, mimeType: string | null): FileLike };
    try {
      directory = await fs.Directory.pickDirectoryAsync();
    } catch {
      // The picker closed without a folder.
      return 'dismissed';
    }
    try {
      directory.createFile(name, 'application/json').write(json);
      return 'saved';
    } catch {
      return 'failed';
    }
  }

  let file: FileLike | null = null;
  try {
    file = new fs.File(...([fs.Paths.cache, EXPORT_DIRECTORY, name] as never[]));
    file.create({ intermediates: true, overwrite: true });
    file.write(json);
    const result = await (deps.share ?? defaultShare)({ url: file.uri });
    return result.action === 'dismissedAction' ? 'dismissed' : 'shared';
  } catch {
    return 'failed';
  } finally {
    try {
      if (file?.exists) file.delete();
    } catch {
      // A cache file the system couldn't remove is cleared with the cache.
    }
  }
}

/**
 * The one place a card leaves the phone (C9, Decision D10). If `expo-sharing` is ever approved
 * (a native change), only this file changes.
 *
 * - **iOS:** the card's SVG is rendered to a PNG (`toDataURL`), written to `share/<uuid>.png` in
 *   the cache directory, and handed to the share sheet with the caption as its message. The file
 *   is deleted on every path — shared, dismissed or failed — so no card image outlives the sheet.
 * - **Android:** React Native's `Share` can't share a file, so the card goes as text: the caption
 *   alone (`captionFor`). Nothing is rendered or written.
 *
 * Nothing is logged: the caption is the driver's to send, not the app's to record.
 */
import { Platform, Share } from 'react-native';

import { captionFor, type CardModel } from './cardModel';

export type ShareOutcome = 'shared' | 'dismissed' | 'failed';

/** The slice of react-native-svg's `Svg` ref used: its PNG snapshot. */
export interface SvgSnapshot {
  toDataURL(callback: (base64: string) => void, options?: object): void;
}

/** `expo-file-system`'s `File` and `Paths`, or a test's stand-in. */
export interface ShareFsLike {
  Paths: { cache: unknown };
  File: new (...parts: never[]) => {
    uri: string;
    exists: boolean;
    create(options?: { intermediates?: boolean; overwrite?: boolean }): void;
    write(content: string, options?: { encoding?: 'utf8' | 'base64' }): void;
    delete(): void;
  };
}

export interface ShareDeps {
  platform?: string;
  share?: (content: { message?: string; url?: string }) => Promise<{ action: string }>;
  loadFs?: () => Promise<ShareFsLike>;
  uuid?: () => string;
  /** How long the PNG snapshot may take before the share gives up (default 5 s). */
  snapshotTimeoutMs?: number;
}

/** The card's pixel size: 1080 × 1350 (4:5), the size the preview draws at scale. */
export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;

const SHARE_DIRECTORY = 'share';

function snapshot(svg: SvgSnapshot, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      svg.toDataURL(
        (base64) => {
          clearTimeout(timer);
          resolve(typeof base64 === 'string' && base64.length > 0 ? base64 : null);
        },
        { width: CARD_WIDTH, height: CARD_HEIGHT }
      );
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

const outcomeOf = (result: { action: string }): ShareOutcome =>
  result.action === 'dismissedAction' ? 'dismissed' : 'shared';

const defaultShare = (content: { message?: string; url?: string }) =>
  Share.share(content as { message: string; url?: string });

async function defaultLoadFs(): Promise<ShareFsLike> {
  return (await import('expo-file-system')) as unknown as ShareFsLike;
}

async function defaultUuid(): Promise<string> {
  const { randomUUID } = await import('expo-crypto');
  return randomUUID();
}

/** Share `model` from the card drawn by `svg`. Never throws. */
export async function shareCard(svg: SvgSnapshot | null, model: CardModel, deps: ShareDeps = {}): Promise<ShareOutcome> {
  const platform = deps.platform ?? Platform.OS;
  const share = deps.share ?? defaultShare;
  const message = captionFor(model);

  if (platform !== 'ios') {
    try {
      return outcomeOf(await share({ message }));
    } catch {
      return 'failed';
    }
  }

  if (svg === null) return 'failed';
  const base64 = await snapshot(svg, deps.snapshotTimeoutMs ?? 5_000);
  if (base64 === null) return 'failed';

  let file: InstanceType<ShareFsLike['File']> | null = null;
  try {
    const { File, Paths } = await (deps.loadFs ?? defaultLoadFs)();
    const name = `${deps.uuid ? deps.uuid() : await defaultUuid()}.png`;
    file = new File(...([Paths.cache, SHARE_DIRECTORY, name] as never[]));
    file.create({ intermediates: true, overwrite: true });
    file.write(base64, { encoding: 'base64' });
    return outcomeOf(await share({ url: file.uri, message }));
  } catch {
    return 'failed';
  } finally {
    try {
      if (file?.exists) file.delete();
    } catch {
      // A cache file the system couldn't remove is cleared with the cache; nothing to tell.
    }
  }
}

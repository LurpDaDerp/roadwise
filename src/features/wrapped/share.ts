/**
 * Sharing a Wrapped: the summary card as an image, with a line and the month's link. The link is
 * made (or refreshed) on the server only at share time (`create_wrapped_share`); the share sheet
 * gets the image and the text with the link together (React Native's `Share` on iPhone;
 * drive-sense's chooser on Android, where `Share` would drop the image).
 */
import { nativeShareImage } from '@drive-sense';
import type { RefObject } from 'react';
import { PixelRatio, Platform, Share, type View } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import { createWrappedShare, type WrappedCore } from '@/data/server/wrapped';
import { wrappedLink } from '@/features/social/links';
import { removeShareImage } from '@/lib/shareImages';

import { archetypeName } from './archetypes';
import { wrappedCopy as copy } from './copy';
import { monthName } from './month';
import { CARD_EXPORT } from './SummaryCard';

/** "My October on RoadWise: Spotless Commuter. roadwise://w/Ab3dEf7hJk9m". */
export function shareMessage(core: Pick<WrappedCore, 'month' | 'archetype'>, link: string): string {
  return copy.summary.shareMessage(monthName(core.month), archetypeName(core.archetype), link);
}

/**
 * The size to ask `captureRef` for so the image comes out at `CARD_EXPORT` pixels. iOS reads the size
 * in points and draws at the screen's scale, so it gets the pixel size over the pixel ratio; Android
 * reads it in pixels.
 */
export function exportSize(): { width: number; height: number } {
  if (Platform.OS !== 'ios') return { ...CARD_EXPORT };
  const r = PixelRatio.get() || 1;
  return { width: CARD_EXPORT.width / r, height: CARD_EXPORT.height / r };
}

/**
 * Captures the card, makes the month's link, then opens the share sheet. Throws when any step fails.
 *
 * iPhone: the captured image is deleted however the sheet ends (it is done with the file by then).
 * Android: the chooser answers once it is up, and the app picked may still be reading the image, so
 * a handed-over image stays for the sweep of share files 10 minutes old (`sweepStaleShareFiles`);
 * one never handed over (no link, no sheet) goes at once. An Android build without the native
 * chooser shares the text alone, as React Native's `Share` can.
 */
export async function shareWrapped(card: RefObject<View | null>, core: Pick<WrappedCore, 'month' | 'archetype'>): Promise<void> {
  const uri = await captureRef(card, { format: 'png', quality: 1, result: 'tmpfile', ...exportSize() });
  const native = Platform.OS === 'android' ? nativeShareImage() : null;
  let handed = false;
  try {
    const id = await createWrappedShare(core.month);
    const message = shareMessage(core, wrappedLink(id));
    if (native) {
      handed = await native(uri, { text: message });
      if (!handed) throw new Error('share sheet did not open');
    } else {
      await Share.share({ url: uri, message });
    }
  } finally {
    if (!handed) removeShareImage(uri);
  }
}

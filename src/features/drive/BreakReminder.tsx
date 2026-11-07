// The break reminder on the driving screen: after 2 hours of driving, at the first stop with
// RoadWise in front (then every hour), "Take a break soon" in the band for 4 s with a cup glyph, as
// the player gives its soft tone and the same words. The host decides when (`src/drive/breakWatch.ts`);
// this draws it, on the spot nudge's bar: the screen's ink, never a tier colour (advice, not an
// event). No touch target.
import { memo, useMemo } from 'react';

import { BREAK_REMINDER_MS, type BreakReminder } from '@/drive/breakWatch';
import type { HudPalette } from '@/ui/drive';

import { useFlash } from './EventBanner';
import { hudCopy } from './hudCopy';
import { NudgeBar } from './SpotNudge';

/** A reminder on screen, with the JS time its 4 s end. */
export type ShownBreak = BreakReminder & { until: number };

/**
 * The reminder to show right now: each new one (by its key) for what is left of
 * `BREAK_REMINDER_MS` (4 s) on the row clock, then nothing. Never the one standing when the screen
 * mounts, and never one already 4 s old when it reaches the screen.
 */
export function useBreakFlash(reminder: BreakReminder | null, rowTs: number | null, now: () => number = Date.now): ShownBreak | null {
  const f = useFlash(reminder?.key ?? null, reminder?.at ?? null, rowTs, BREAK_REMINDER_MS, now);
  return useMemo(() => (f === null || reminder === null ? null : { ...reminder, until: f.until }), [f, reminder]);
}

function BreakReminderLineView({ palette, compact }: { palette: HudPalette; compact: boolean }) {
  return <NudgeBar testID="hud-break" icon="cafe-outline" words={hudCopy.breakReminder} palette={palette} compact={compact} />;
}

export const BreakReminderLine = memo(BreakReminderLineView);

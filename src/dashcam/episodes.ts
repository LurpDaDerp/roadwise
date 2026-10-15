// How a drive's DashPal events become scoring candidates (plan §7.6). Pure; used by `facts.ts`.
import { DETAIL, EV } from './protocol';

/** Events within this long of an open episode join it (plan §7.6). */
export const EPISODE_GAP_MS = 60_000;
/** The samples row for an episode's speed: at most this far from the first event's fire time. */
export const SPEED_NEAR_MS = 2_000;
/** `synced` when the phone was caught up at most this long before the drive ended. */
export const SYNCED_WITHIN_MS = 30_000;

export interface EpisodeEvent {
  id: string;
  ev: number;
  detail: number;
  /** condition start and fire time, epoch ms (from the boot's best offset now) */
  startedAt: number;
  firedAt: number;
}

/** Drowsy evidence: a microsleep, sleep, or eyes-closed unresponsive. */
const isDrowsy = (e: EpisodeEvent): boolean =>
  e.ev === EV.MICROSLEEP || e.ev === EV.SLEEP || (e.ev === EV.UNRESPONSIVE && e.detail === DETAIL.EYES_CLOSED);
/**
 * Eyes-off evidence: no return after a distraction warning (D4), or a slump out of view at speed
 * (the dashcam's no-face rule sends it with the same detail). FACE_LOST itself is never evidence.
 */
const isEyesOff = (e: EpisodeEvent): boolean => e.ev === EV.UNRESPONSIVE && e.detail === DETAIL.NO_RETURN;
/** No return after a critical (F3): joins an episode, never starts one. */
const isFollowUp = (e: EpisodeEvent): boolean => e.ev === EV.UNRESPONSIVE && e.detail === DETAIL.NO_RETURN_CRITICAL;

/**
 * Group the drive's audible critical events into episodes (plan §7.6): events within 60 s of an
 * open episode merge into it; the episode is `drowsy` if it holds drowsy evidence, else `eyes_off`
 * if it holds a D4; an F3 alone never starts one. Pure; `events` in any order.
 */
export function episodes(events: readonly EpisodeEvent[]): { first: EpisodeEvent; kind: 'eyes_off' | 'drowsy'; startedAt: number; endedAt: number }[] {
  const relevant = events.filter((e) => isDrowsy(e) || isEyesOff(e) || isFollowUp(e));
  const sorted = [...relevant].sort((a, b) => a.startedAt - b.startedAt || a.firedAt - b.firedAt);
  const out: { first: EpisodeEvent; members: EpisodeEvent[]; startedAt: number; endedAt: number }[] = [];
  let open: (typeof out)[number] | null = null;
  for (const e of sorted) {
    if (open && e.startedAt <= open.endedAt + EPISODE_GAP_MS) {
      open.members.push(e);
      open.endedAt = Math.max(open.endedAt, e.firedAt);
      continue;
    }
    if (isFollowUp(e)) {
      open = null;
      continue;
    }
    open = { first: e, members: [e], startedAt: e.startedAt, endedAt: Math.max(e.startedAt, e.firedAt) };
    out.push(open);
  }
  const result: { first: EpisodeEvent; kind: 'eyes_off' | 'drowsy'; startedAt: number; endedAt: number }[] = [];
  for (const ep of out) {
    const kind = ep.members.some(isDrowsy) ? 'drowsy' : ep.members.some(isEyesOff) ? 'eyes_off' : null;
    if (kind !== null) result.push({ first: ep.first, kind, startedAt: ep.startedAt, endedAt: ep.endedAt });
  }
  return result;
}

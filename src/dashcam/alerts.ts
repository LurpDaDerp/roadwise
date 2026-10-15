// The phone side of a DashPal alert (plan §3.5, §7.8): what the phone plays when the dashcam routes
// an alert to it, and for how long.
//
// - `route = 1`: the link answers ALERT_ACK(1) before the first play when the phone can play now,
//   else ALERT_ACK(0) and the alert is haptic + visual only. `route = 0`: haptic + visual only, never
//   an ACK, never a sound.
// - A continuous alert repeats until ALERT_STOP, ALERT_FALLBACK cause 1–3, a disconnect, or 3 s with
//   no frame from the dashcam. Cause 4 (the buzzer joined) keeps it playing. One-shots play once.
// - Cadence, start to start and never faster than an item finishes: glance 2.5 s, drowsy 4 s, wake
//   1.5 s at level 0, 1.25 s at level 1, 1.0 s from level 2; phone 2.5 s; no face 5 s.
// - At most one DashPal item is queued or playing; the next repeat is scheduled once the previous
//   `deliver()` resolved. A generation token, bumped by every stop, drops a repeat already queued
//   (`stillWanted`). A tier-3 alert preempts the player's queue.
// - The voice line on the first play and on a level change only; "Wake up" is spoken even with the
//   voice setting off. Repeats vibrate at intensity 2.
// - The no-face alert (sound 6, "Driver not visible") can last minutes, so it is gentle: its first
//   play is not spoken when another no-face alert ended in the last `NO_FACE_VOICE_QUIET_MS`; each
//   play releases the audio session (music comes back between plays); and it does not count as a
//   continuous alert for `continuousActive`, so the phone's own event tones keep sounding.
// - The phone stops a confirmed alert on its own (staleness, the player failing, the phone no
//   longer able to play): it then sends ALERT_ACK(0) so the dashcam's buzzer takes over.
// - Visual: one flash per ALERT start or level change (the HUD glows 1.5 s), never per repeat.
//
// Pure apart from the player and the clock: time is injected, `tick(now)` advances repeats.
import type { AlertPlayer } from '@/core/alerts/player';
import type { AlertDecision, AlertLevel, AlertTone, HapticIntensity } from '@/core/alerts/types';
import { t } from '@/i18n';

import { FALLBACK_CAUSE, SOUND, type AlertFrame } from './protocol';

export interface SoundSpec {
  level: AlertLevel;
  tone?: AlertTone;
  voice?: string;
  voiceAlways?: true;
  /** haptic strength of the first play (repeats use `REPEAT_INTENSITY`) */
  firstIntensity: HapticIntensity;
}

export const SOUND_SPEC: Readonly<Record<number, SoundSpec>> = {
  [SOUND.GLANCE]: { level: 2, tone: 'dp_glance', voice: t('dashpal.eyesOnRoad'), firstIntensity: 2 },
  [SOUND.DROWSY]: { level: 3, tone: 'dp_drowsy', voice: t('dashpal.takeABreak'), firstIntensity: 3 },
  [SOUND.WAKE]: { level: 3, tone: 'dp_wake', voice: t('dashpal.wakeUp'), voiceAlways: true, firstIntensity: 4 },
  [SOUND.PHONE]: { level: 3, tone: 'dp_phone', voice: t('dashpal.phoneDown'), firstIntensity: 3 },
  [SOUND.CHIME]: { level: 1, firstIntensity: 1 },
  [SOUND.NO_FACE]: { level: 2, tone: 'dp_glance', voice: t('dashpal.driverNotVisible'), firstIntensity: 2 },
};

/** An unknown sound (a later firmware) plays as the advisory chime. */
export const specFor = (sound: number): SoundSpec => SOUND_SPEC[sound] ?? SOUND_SPEC[SOUND.CHIME]!;

export const REPEAT_INTENSITY: HapticIntensity = 2;

/** Start-to-start repeat cadence, ms. */
export function cadenceMs(sound: number, level: number): number {
  switch (sound) {
    case SOUND.DROWSY:
      return 4000;
    case SOUND.WAKE:
      return level >= 2 ? 1000 : level === 1 ? 1250 : 1500;
    case SOUND.NO_FACE:
      return 5000;
    default:
      return 2500;
  }
}

/** No frame from the dashcam for this long: the phone stops a continuous alert. */
export const STALE_MS = 3000;

/** A no-face alert that starts within this long of the previous one ending is not spoken. */
export const NO_FACE_VOICE_QUIET_MS = 60_000;

/** What the HUD and the banner show: one flash per start or level change. */
export interface DashcamVisual {
  /**
   * `${n}:${alertId}:${level}`, `n` counting every flash in the process: a new key flashes again.
   * Alert ids restart at 1 on each dashcam boot, so the id and level alone can repeat.
   */
  key: string;
  alertId: number;
  sound: number;
  tier: number;
  level: number;
  /** the phone plays it (route 1, confirmed) */
  onPhone: boolean;
  at: number;
}

/** Flashes so far in this JS process (outlives a runtime, as the root banner does). */
let flashes = 0;

export interface DashcamAlertDeps {
  player: AlertPlayer;
  now: () => number;
  /** Send ALERT_ACK(outcome) for `alertId` (the link writes it at once). */
  sendAck(alertId: number, outcome: 0 | 1): void;
  /** Read live: the phone can play sound now (the STATE `can_play` rule). */
  canPlay(): boolean;
  onVisual?(v: DashcamVisual): void;
  onChange?(): void;
  onError?(e: unknown): void;
}

interface Entry {
  id: number;
  sound: number;
  tier: number;
  level: number;
  continuous: boolean;
  /** route 1 and confirmed with ACK(1): the phone sounds it */
  playing: boolean;
  /** an ACK(1) went out for it (so the phone owes an ACK(0) if it stops on its own) */
  confirmed: boolean;
  /** the next play speaks (first play, level change) */
  speak: boolean;
  /** plays so far */
  plays: number;
  lastStartAt: number | null;
  /** when the next repeat may start; null while one is in flight or none is due */
  nextAt: number | null;
  /** the first play (or the haptic for a visual-only alert) is still owed */
  firstOwed: boolean;
  escalated: boolean;
}

export interface DashcamAlertController {
  /** An ALERT frame. Returns the ACK the link must send BEFORE playback starts (null: none). */
  onAlert(frame: AlertFrame): 0 | 1 | null;
  /** The table holds this alert (a re-send of it is a level change or a reconnect's visual copy). */
  has(alertId: number): boolean;
  onStop(alertId: number): void;
  onFallback(alertId: number, cause: number): void;
  /** Disconnect, a new boot, or a connect: the table is cleared (no ACK: the dashcam knows). */
  clear(): void;
  /** 3 s with no frame: playing alerts stop and owe ALERT_ACK(0). True when anything stopped. */
  stale(): boolean;
  /** The player failed during a DashPal item: ALERT_ACK(0) for it and stop. */
  playerUnavailable(): void;
  tick(now: number): void;
  /** The earliest time `tick` has work, or null. */
  nextDueAt(): number | null;
  /** A continuous DashPal alert is active (phone-engine alerts are then haptic + visual only). */
  continuousActive(): boolean;
  /** The phone is sounding a DashPal alert right now. */
  playingAny(): boolean;
  settled(): Promise<void>;
}

export function createDashcamAlerts(deps: DashcamAlertDeps): DashcamAlertController {
  const table = new Map<number, Entry>();
  /** bumped by every stop; an item queued under an older generation is dropped unstarted */
  let gen = 0;
  /** the one DashPal item allowed in the player at a time */
  let inFlight: { alertId: number; done: Promise<void> } | null = null;
  let seq = 0;
  /** when a no-face alert last left the table (stopped, superseded, cleared) */
  let lastNoFaceEndAt = -Infinity;

  function noFaceEnded(e: Entry): void {
    if (e.sound === SOUND.NO_FACE) lastNoFaceEndAt = deps.now();
  }

  function report(e: unknown): void {
    try {
      deps.onError?.(e);
    } catch {
      // nobody left to tell
    }
  }

  function changed(): void {
    try {
      deps.onChange?.();
    } catch (e) {
      report(e);
    }
  }

  function flash(e: Entry): void {
    try {
      flashes += 1;
      deps.onVisual?.({ key: `${flashes}:${e.id}:${e.level}`, alertId: e.id, sound: e.sound, tier: e.tier, level: e.level, onPhone: e.playing, at: deps.now() });
    } catch (err) {
      report(err);
    }
  }

  function stopPlayer(): void {
    deps.player.stopCurrent().catch(report);
  }

  /**
   * Cut `e`'s item if it is the one in the player, or release the session a continuous alert held
   * between repeats; another DashPal item in flight is left alone.
   */
  function cut(e: Entry): void {
    gen += 1;
    if (inFlight === null || inFlight.alertId === e.id) stopPlayer();
  }

  /** Stop the phone sounding `e` (it stays in the table for the visual). */
  function silence(e: Entry, owesAck: boolean): void {
    const wasSounding = e.playing;
    e.playing = false;
    e.nextAt = null;
    if (owesAck && e.confirmed) {
      e.confirmed = false;
      try {
        deps.sendAck(e.id, 0);
      } catch (err) {
        report(err);
      }
    }
    if (wasSounding) cut(e);
  }

  function decisionFor(e: Entry, first: boolean): AlertDecision {
    const spec = specFor(e.sound);
    const myGen = gen;
    const id = e.id;
    const sounding = e.playing;
    seq += 1;
    const d: AlertDecision = {
      id: `dashpal:${id}:${seq}`,
      level: spec.level,
      kind: 'dashpal',
      ts: deps.now(),
      intensity: first ? spec.firstIntensity : REPEAT_INTENSITY,
      // Dropped unstarted once the alert stopped, the phone stopped sounding it, or anything was cut.
      stillWanted: () => gen === myGen && table.get(id) === e && (!sounding || e.playing),
    };
    if (spec.tone) d.tone = spec.tone;
    if (!e.playing) {
      d.silent = true;
      return d;
    }
    if (e.speak && spec.voice) {
      d.voice = spec.voice;
      if (spec.voiceAlways) d.voiceAlways = true;
    }
    // The no-face alert releases the session after each play: music comes back between its plays.
    if (e.continuous && e.sound !== SOUND.NO_FACE) d.holdSession = true;
    return d;
  }

  /** Hand the due item (if any) to the player; one at a time. */
  function pump(): void {
    if (inFlight) return;
    const now = deps.now();
    // A first play wins over a repeat; a higher tier first, then the newest.
    const candidates = [...table.values()].filter((e) => e.firstOwed || (e.playing && e.nextAt !== null && e.nextAt <= now));
    if (candidates.length === 0) return;
    candidates.sort((a, b) => Number(b.firstOwed) - Number(a.firstOwed) || b.tier - a.tier || (b.lastStartAt ?? Infinity) - (a.lastStartAt ?? Infinity));
    const e = candidates[0]!;
    const first = e.firstOwed;
    e.firstOwed = false;
    const decision = decisionFor(e, first);
    e.speak = false;
    e.plays += 1;
    e.lastStartAt = now;
    e.nextAt = null;
    const startedAt = now;
    const done = deps.player
      .deliver(decision)
      .catch(report)
      .then(() => {
        inFlight = null;
        const at = deps.now();
        if (table.get(e.id) === e) {
          if (e.playing && e.continuous) e.nextAt = Math.max(startedAt + cadenceMs(e.sound, e.level), at);
          // A one-shot is done once played (a level change cannot follow it).
          else if (!e.continuous && !e.firstOwed) table.delete(e.id);
        }
        pump();
        changed();
      });
    inFlight = { alertId: e.id, done };
  }

  return {
    has(alertId) {
      return table.has(alertId);
    },

    onAlert(f) {
      const existing = table.get(f.alertId);
      if (existing) {
        // The same alert again: a level change (no new ACK), or the visual-only re-send after a
        // reconnect for an alert the phone already knows.
        if (existing.level !== f.level) {
          existing.level = f.level;
          existing.speak = true;
          if (!existing.playing) existing.firstOwed = true; // one haptic for the step up
          flash(existing);
          pump();
          changed();
        }
        return null;
      }
      let ack: 0 | 1 | null = null;
      let playing = false;
      if (f.route === 1) {
        const can = (() => {
          try {
            return deps.canPlay();
          } catch (e) {
            report(e);
            return false;
          }
        })();
        ack = can ? 1 : 0;
        playing = can;
      }
      const e: Entry = {
        id: f.alertId,
        sound: f.sound,
        tier: f.tier,
        level: f.level,
        continuous: f.mode === 1,
        playing,
        confirmed: ack === 1,
        // A no-face alert right after another one shows its banner without saying it again.
        speak: !(f.sound === SOUND.NO_FACE && deps.now() - lastNoFaceEndAt < NO_FACE_VOICE_QUIET_MS),
        plays: 0,
        lastStartAt: null,
        nextAt: null,
        firstOwed: true,
        escalated: false,
      };
      table.set(f.alertId, e);
      flash(e);
      if (playing && f.tier >= 3) {
        // A dashcam critical preempts whatever the player is doing (a phone alert, another DashPal
        // item); its first play then starts as soon as that settles.
        gen += 1;
        stopPlayer();
      }
      // The ACK must leave before the first play starts: the caller sends it, then pumps via tick.
      queueMicrotask(() => {
        pump();
        changed();
      });
      return ack;
    },

    onStop(alertId) {
      const e = table.get(alertId);
      if (!e) return;
      table.delete(alertId);
      noFaceEnded(e);
      if (e.playing || inFlight?.alertId === alertId) cut(e);
      changed();
    },

    onFallback(alertId, cause) {
      const e = table.get(alertId);
      if (!e) return;
      if (cause === FALLBACK_CAUSE.ESCALATION) {
        e.escalated = true;
        changed();
        return;
      }
      // The dashcam took it over (no ACK in time, the phone said cannot, the lease lapsed): the
      // phone stops; it owes nothing.
      e.confirmed = false;
      silence(e, false);
      changed();
    },

    clear() {
      if (table.size === 0 && !inFlight) return;
      const sounding = [...table.values()].some((e) => e.playing) || inFlight !== null;
      for (const e of table.values()) noFaceEnded(e);
      table.clear();
      gen += 1;
      if (sounding) stopPlayer();
      changed();
    },

    stale() {
      let any = false;
      for (const e of table.values()) {
        if (e.playing && e.continuous) {
          silence(e, true);
          any = true;
        }
      }
      if (any) changed();
      return any;
    },

    playerUnavailable() {
      const id = inFlight?.alertId;
      if (id === undefined) return;
      const e = table.get(id);
      if (!e || !e.playing) return;
      silence(e, true);
      changed();
    },

    tick(now) {
      // A phone that can no longer play (a call began, the app left the screen outside a drive):
      // the dashcam's buzzer takes over.
      let can = true;
      try {
        can = deps.canPlay();
      } catch (e) {
        report(e);
      }
      if (!can) {
        let any = false;
        for (const e of table.values()) {
          if (e.playing) {
            silence(e, true);
            any = true;
          }
        }
        if (any) changed();
      }
      void now;
      pump();
    },

    nextDueAt() {
      // While a DashPal item is in the player nothing else can start; its settling pumps whatever is
      // due by then. Only a repeat still in the future is worth a wake (else: a zero-delay loop).
      const now = deps.now();
      let at: number | null = null;
      for (const e of table.values()) {
        if (e.firstOwed && inFlight === null) return now;
        if (!e.playing || e.nextAt === null || (inFlight !== null && e.nextAt <= now)) continue;
        at = at === null ? e.nextAt : Math.min(at, e.nextAt);
      }
      return at;
    },

    // The no-face alert leaves the phone's own alert tones on (it can last minutes).
    continuousActive: () => [...table.values()].some((e) => e.continuous && e.sound !== SOUND.NO_FACE),
    playingAny: () => [...table.values()].some((e) => e.playing),

    async settled() {
      for (let i = 0; i < 50; i++) {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        const f = inFlight;
        if (f) await f.done;
        else if (![...table.values()].some((e) => e.firstOwed)) return;
      }
    },
  };
}

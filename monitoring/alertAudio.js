// Alert audio policy (docs/UX_REWORK.md §5.4):
//   INFO      → displayed only
//   WARNING   → once: the type's own tone and/or its spoken phrase; one haptic pulse
//   CRITICAL  → the same on start, then repeated every REPEAT_MS while it persists
// Used for monitoring alerts and, through useDriveSession, for speeding and
// phone-use banners so every audible cue follows one rule.
//
// Per-type tones (Euro NCAP asks for drowsiness and distraction to be acoustically distinct):
// monitoring/types.js carries a `sound` name per alert type and the four WAVs live in
// assets/sounds/dms/. They are require()d in the static map below, which is what makes Metro
// bundle them; an alert whose `sound` is null plays no tone, and anything else falls back to the
// generic tone the screen passes in.
import { useEffect, useMemo, useRef } from 'react';
import { Vibration } from 'react-native';
import { useAudioPlayer } from 'expo-audio';
import { ALERT_SEVERITY } from './types';
import { speak, SPEECH_PRIORITY } from '../utils/speech';

const REPEAT_MS = 4000;
/** Nothing reads these players' status, so the native status timer can be slow. */
const STATUS_INTERVAL_MS = 10000;

const CRITICAL_PATTERN = [0, 300, 150, 300];
const WARNING_MS = 150;

// Static requires: Metro only bundles an asset it can see at build time.
const SIREN = require('../assets/sounds/dms/siren.wav');
const DOUBLE_HIGH = require('../assets/sounds/dms/double_high.wav');
const DOUBLE_LOW = require('../assets/sounds/dms/double_low.wav');
const SINGLE_LOW = require('../assets/sounds/dms/single_low.wav');

/**
 * The four alert tones as expo-audio players, in the shape `playCue` expects for `players`.
 * Created once per screen; they hold no audio session until something is played.
 */
export function useAlertSounds() {
  const siren = useAudioPlayer(SIREN, STATUS_INTERVAL_MS);
  const doubleHigh = useAudioPlayer(DOUBLE_HIGH, STATUS_INTERVAL_MS);
  const doubleLow = useAudioPlayer(DOUBLE_LOW, STATUS_INTERVAL_MS);
  const singleLow = useAudioPlayer(SINGLE_LOW, STATUS_INTERVAL_MS);
  return useMemo(
    () => ({ siren, double_high: doubleHigh, double_low: doubleLow, single_low: singleLow }),
    [siren, doubleHigh, doubleLow, singleLow]
  );
}

/**
 * Which player an alert should use.
 *   `sound` names one of the four tones  → that tone
 *   `sound` is explicitly null           → silence (EYES_NOT_VISIBLE)
 *   no `sound` key at all                → the generic tone the caller passed (speeding, phone use)
 */
export function resolveTonePlayer({ sound, players, player }) {
  if (sound === null) return null;
  if (typeof sound === 'string' && players && players[sound]) return players[sound];
  return player || null;
}

export function playCue({ severity, speech, player, players, sound, voice, tone, haptic }) {
  const isCritical = severity === ALERT_SEVERITY.CRITICAL;
  try {
    if (tone) {
      const chosen = resolveTonePlayer({ sound, players, player });
      if (chosen) {
        chosen.seekTo(0);
        chosen.play();
      }
    }
    // The alert priority: a safety phrase may cut off a speed-limit announcement, never the
    // other way round (utils/speech.js).
    if (voice && speech) speak(speech, { priority: SPEECH_PRIORITY.ALERT });
  } catch (e) {
    console.warn('Alert cue failed:', e);
  }
  if (haptic) {
    try {
      Vibration.vibrate(isCritical ? CRITICAL_PATTERN : WARNING_MS);
    } catch {}
  }
}

// activeAlert: { id, severity, speech?, sound?, title, audio? } | null — an alert may carry its
// own modality (`audio: { voice, tone, haptic }`), e.g. speeding = tone + banner; otherwise
// the defaults (the monitoring voice / tone / haptic settings) apply.
// audio: { voice, tone, haptic, player, players } — `player` is the generic expo-audio player,
// `players` the per-type map from useAlertSounds().
export function useAlertAudio(activeAlert, audio) {
  const repeatRef = useRef(null);
  const audioRef = useRef(audio);
  const alertRef = useRef(activeAlert);
  useEffect(() => {
    audioRef.current = audio;
  }, [audio]);
  useEffect(() => {
    alertRef.current = activeAlert;
  }, [activeAlert]);

  const id = activeAlert?.id || null;
  const severity = activeAlert?.severity || null;

  // Re-arms only when the alert identity or its severity changes, so a
  // settings change never silences a live CRITICAL alert and an escalation
  // WARNING → CRITICAL with the same id plays and repeats.
  useEffect(() => {
    const stop = () => {
      if (repeatRef.current) {
        clearInterval(repeatRef.current);
        repeatRef.current = null;
      }
    };
    stop();
    if (!id || severity === ALERT_SEVERITY.INFO) return stop;
    const cue = () => {
      const a = alertRef.current;
      const s = { ...(audioRef.current || {}), ...(a?.audio || {}) };
      if (!a) return;
      playCue({
        severity,
        speech: a.speech,
        sound: a.sound,
        player: s.player,
        players: s.players,
        voice: s.voice,
        tone: s.tone,
        haptic: s.haptic,
      });
    };
    cue();
    if (severity === ALERT_SEVERITY.CRITICAL) repeatRef.current = setInterval(cue, REPEAT_MS);
    return stop;
  }, [id, severity]);
}

export default useAlertAudio;

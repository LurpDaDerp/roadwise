// Alert audio policy (docs/UX_REWORK.md §5.4):
//   INFO      → displayed only
//   WARNING   → once: spoken phrase (voice) or tone; one haptic pulse
//   CRITICAL  → the same on start, then repeated every REPEAT_MS while it persists
// Used for monitoring alerts and, through useDriveSession, for speeding and
// phone-use banners so every audible cue follows one rule.
import { useEffect, useRef } from 'react';
import { Vibration, Platform } from 'react-native';
import * as Speech from 'expo-speech';
import { ALERT_SEVERITY } from './types';

const REPEAT_MS = 4000;

export function playCue({ severity, speech, player, voice, tone, haptic }) {
  const isCritical = severity === ALERT_SEVERITY.CRITICAL;
  try {
    if (tone && player) {
      player.seekTo(0);
      player.play();
    }
    if (voice && speech) {
      Speech.stop();
      Speech.speak(speech, { language: 'en', pitch: 0.9, rate: 0.95 });
    }
  } catch (e) {
    console.warn('Alert cue failed:', e);
  }
  if (haptic) {
    try {
      if (isCritical) Vibration.vibrate(Platform.OS === 'android' ? [0, 300, 150, 300] : [0, 300, 150, 300]);
      else Vibration.vibrate(150);
    } catch {}
  }
}

// activeAlert: { id, severity, speech?, title, audio? } | null — an alert may carry its
// own modality (`audio: { voice, tone, haptic }`), e.g. speeding = tone + banner; otherwise
// the defaults (the monitoring voice / tone / haptic settings) apply.
// audio: { voice, tone, haptic, player } — player is an expo-audio player for the tone.
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
      playCue({ severity, speech: a.speech, player: s.player, voice: s.voice, tone: s.tone, haptic: s.haptic });
    };
    cue();
    if (severity === ALERT_SEVERITY.CRITICAL) repeatRef.current = setInterval(cue, REPEAT_MS);
    return stop;
  }, [id, severity]);
}

export default useAlertAudio;

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
    if (voice && speech) {
      Speech.stop();
      Speech.speak(speech, { language: 'en', pitch: 0.9, rate: 0.95 });
    } else if (tone && player) {
      player.seekTo(0);
      player.play();
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

// activeAlert: { id, severity, speech? , title } | null
// audio: { voice, tone, haptic, player } — player is an expo-audio player for the tone.
export function useAlertAudio(activeAlert, audio) {
  const lastId = useRef(null);
  const repeatRef = useRef(null);

  useEffect(() => {
    const stop = () => {
      if (repeatRef.current) {
        clearInterval(repeatRef.current);
        repeatRef.current = null;
      }
    };
    if (!activeAlert || activeAlert.severity === ALERT_SEVERITY.INFO) {
      stop();
      lastId.current = activeAlert?.id || null;
      return stop;
    }
    if (activeAlert.id === lastId.current) return stop;
    lastId.current = activeAlert.id;
    stop();
    const cue = () =>
      playCue({
        severity: activeAlert.severity,
        speech: activeAlert.speech,
        player: audio?.player,
        voice: audio?.voice,
        tone: audio?.tone,
        haptic: audio?.haptic,
      });
    cue();
    if (activeAlert.severity === ALERT_SEVERITY.CRITICAL) {
      repeatRef.current = setInterval(cue, REPEAT_MS);
    }
    return stop;
  }, [activeAlert?.id, activeAlert?.severity, audio?.voice, audio?.tone, audio?.haptic, audio?.player]);
}

export default useAlertAudio;

// One owner for spoken output.
//
// Two places speak during a drive: the speed-limit change in hooks/useDriveSession.js and the
// alert cue in monitoring/alertAudio.js. Both used to call Speech.stop() and then Speech.speak(),
// so whichever fired second cut the other off mid-word - including a safety alert being cut off
// by "Speed limit 35". Everything now goes through speak(), which knows what is currently being
// said and refuses to talk over something more important.
import * as Speech from 'expo-speech';

export const SPEECH_PRIORITY = Object.freeze({
  INFO: 1,    // speed-limit changes and other conveniences
  ALERT: 2,   // a monitoring alert: may interrupt INFO, never the other way round
});

const DEFAULTS = { language: 'en', pitch: 0.9, rate: 0.95 };
/** Nothing should hold the channel longer than this if a callback never arrives. */
const MAX_UTTERANCE_MS = 8000;

let currentPriority = 0;
let token = 0;
let watchdog = null;

function release(mine) {
  if (mine !== token) return;      // a newer utterance already owns the channel
  currentPriority = 0;
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

/**
 * Speak `text`, unless something of higher priority is being said.
 * @returns {boolean} true when the utterance was started.
 */
export function speak(text, { priority = SPEECH_PRIORITY.INFO, ...options } = {}) {
  if (!text) return false;
  if (priority < currentPriority) return false;
  const mine = ++token;
  currentPriority = priority;
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(() => release(mine), MAX_UTTERANCE_MS);
  try {
    // Stops the PREVIOUS utterance, whose token is not `mine`, so its onStopped cannot release
    // the channel this one just took.
    Speech.stop();
    Speech.speak(text, {
      ...DEFAULTS,
      ...options,
      onDone: () => release(mine),
      onStopped: () => release(mine),
      onError: () => release(mine),
    });
    return true;
  } catch (err) {
    release(mine);
    return false;
  }
}

/** Stop whatever is being said and free the channel. */
export function stopSpeech() {
  token += 1;
  currentPriority = 0;
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
  try {
    Speech.stop();
  } catch (err) {
    // nothing to stop
  }
}

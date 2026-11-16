/**
 * Android only: no media-playback foreground service in the app.
 *
 * expo-audio's `enableBackgroundPlayback` (app.config.ts) is there for iOS: it adds the `audio`
 * background mode, so alerts sound with the screen locked. On Android the same flag only declares
 * expo-audio's AudioControlsService (a MediaSessionService of type mediaPlayback) and
 * FOREGROUND_SERVICE_MEDIA_PLAYBACK. That service exists for lock-screen media controls, which it
 * starts only from `setActiveForLockScreen`; RoadWise never calls it. Android plays RoadWise's alerts
 * in the background without it: expo-audio keeps playing on `shouldPlayInBackground` (every audio
 * mode RoadWise sets on Android, src/core/alerts/adapters.ts), the drive's location service keeps the
 * process alive during a drive and the DashPal link service (connectedDevice) while a DashPal is
 * paired, and the spoken words (expo-speech, Android's TextToSpeech) need no service of their own.
 *
 * An unused mediaPlayback service still asks for a Play Console foreground-service declaration, so
 * it is removed (`tools:node="remove"`, which wins whichever plugin runs first: expo-audio never
 * adds a service of a name already listed), and app.config.ts blocks the permission.
 */
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const SERVICE = 'expo.modules.audio.service.AudioControlsService';

function removeMediaPlaybackService(manifest) {
  manifest.manifest.$ = { ...manifest.manifest.$, 'xmlns:tools': 'http://schemas.android.com/tools' };
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  const marker = { $: { 'android:name': SERVICE, 'tools:node': 'remove' } };
  const services = app.service ?? [];
  const at = services.findIndex((s) => s.$?.['android:name'] === SERVICE);
  if (at === -1) services.push(marker);
  else services[at] = marker;
  app.service = services;
  return manifest;
}

const withAndroidNoMediaPlaybackService = (config) =>
  withAndroidManifest(config, (c) => {
    removeMediaPlaybackService(c.modResults);
    return c;
  });

module.exports = withAndroidNoMediaPlaybackService;
module.exports.removeMediaPlaybackService = removeMediaPlaybackService;
module.exports.SERVICE = SERVICE;

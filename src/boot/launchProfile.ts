/**
 * Why this process was started, and what it may therefore do (design §3.5; plan rev1: I3).
 *
 * A RoadWise process starts for one of two reasons:
 *   - **foreground** — the driver opened the app. Hydration, the config fetch and uploads are
 *     allowed (throttled; `startForegroundJobs`);
 *   - **background** — an iOS location or motion wake, an iOS relaunch mid-drive, or the Android
 *     headless task (`DriveSenseTask`). The drive engine starts and nothing else: no hydration, no
 *     config fetch, no upload (Android's headless task is the one exception for uploads: "upload
 *     from the service or on foreground", §3.5).
 *
 * The profile is read from `AppState.currentState` once, at boot. Only `active` is foreground:
 * iOS reports `unknown` for a cold start that has not finished becoming active, and treating it as
 * background costs nothing — the foreground work starts on the `active` transition that follows —
 * whereas the other mistake would spend radio time on every background wake.
 */
import { AppState, Platform } from 'react-native';

export type LaunchProfile = 'foreground' | 'background';

/** What this needs of React Native's `AppState`. */
export interface AppStateReading {
  currentState?: string | null;
}

/** The profile of a launch starting now. The headless task passes `'background'` itself. */
export function launchProfile(appState: AppStateReading = AppState): LaunchProfile {
  return appState.currentState === 'active' ? 'foreground' : 'background';
}

// ——— the Android headless task's lifetime ———

/**
 * How many `DriveSenseTask` bodies are running. While one is, the process is Android's headless JS
 * service — the capture's own foreground service — and uploads are allowed from it (§3.5).
 */
let headlessTasks = 0;

/** Called by the headless task around its body; always paired, `finally` included. */
export function enterHeadless(): () => void {
  headlessTasks += 1;
  let left = false;
  return () => {
    if (left) return;
    left = true;
    headlessTasks -= 1;
  };
}

export function isHeadlessActive(): boolean {
  return headlessTasks > 0;
}

export interface DrainPolicyDeps {
  appState?: AppStateReading;
  os?: string;
  headlessActive?: () => boolean;
}

/**
 * The sync runner's `mayDrain` (plan D2, review I3): upload only while the app is in front, or on
 * Android while the headless task runs. Read live at every wake, so a background launch that the
 * driver then opens starts uploading on the `active` transition without a rebuild.
 */
export function drainPolicy(deps: DrainPolicyDeps = {}): () => boolean {
  const appState = deps.appState ?? AppState;
  const os = deps.os ?? Platform.OS;
  const headless = deps.headlessActive ?? isHeadlessActive;
  return () => appState.currentState === 'active' || (os === 'android' && headless());
}

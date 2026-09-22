/**
 * Which build of the app is running, as far as the device can tell — so a record that only holds
 * for one build (the restore's list of server rows this build could not read) is released by the
 * next build on its own, not only by a hand-bumped constant (security review D1 R3-M1).
 *
 * `expo-updates` is a direct dependency and knows both halves: `runtimeVersion` (the native build
 * line, `appVersion` policy here) and `updateId` (the JS bundle actually running — the embedded
 * one or an over-the-air update; it changes with every build and every update). Imported lazily
 * and guarded, because under Jest, in Expo Go or in a development build it may be missing or
 * answer null; the fallback is a fixed id, and the 30-day expiry then does the releasing.
 */
export const UNKNOWN_BUILD = 'unknown-build';

export async function appBuildId(): Promise<string> {
  try {
    const updates = (await import('expo-updates')) as {
      runtimeVersion?: string | null;
      updateId?: string | null;
    };
    const runtime = updates.runtimeVersion ?? null;
    const update = updates.updateId ?? null;
    if (runtime === null && update === null) return UNKNOWN_BUILD;
    return `${runtime ?? '?'}:${update ?? '?'}`;
  } catch {
    return UNKNOWN_BUILD;
  }
}

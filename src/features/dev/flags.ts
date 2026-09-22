// The diagnostics switch on its own (H2 r1): the boot path and the battery-recorder mount read it
// at every launch, background wakes included, so it must not drag in the diagnostics screen or
// expo-router. `DriveDiagnosticsScreen` re-exports it for its route guard and Home's link.
import { env } from '@/lib/env';

/** A developer build, or a build made with the diagnostics flag (`EXPO_PUBLIC_DIAGNOSTICS=1`). */
export function diagnosticsEnabled(): boolean {
  const dev = typeof __DEV__ !== 'undefined' && __DEV__;
  return dev || env.diagnostics;
}

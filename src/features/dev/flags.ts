// The diagnostics switch on its own (H2 r1): the boot path and the battery-recorder mount read it
// at every launch, background wakes included, so it must not drag in the diagnostics screen or
// expo-router. `DriveDiagnosticsScreen` re-exports it for its route guard and Home's link.
import { env } from '@/lib/env';

/**
 * The update channel embedded in this native build, or null when it cannot be read (Jest, a build
 * without expo-updates). It is fixed at build time: no OTA update can change it.
 */
function embeddedChannel(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- read lazily, and never fatal
    const updates = require('expo-updates') as { channel?: unknown };
    return typeof updates.channel === 'string' ? updates.channel : null;
  } catch {
    return null;
  }
}

/**
 * A developer build, or a build made with the diagnostics flag (`EXPO_PUBLIC_DIAGNOSTICS=1`), and never
 * a production-channel build (T15 r2, security m-1(b)): an OTA update inlines EXPO_PUBLIC_* from the
 * publishing shell, so a production update published with the flag set must still not unlock the
 * diagnostics screens, Home's link to them or the battery recorder. The channel lives in the binary.
 */
export function diagnosticsEnabled(): boolean {
  if (embeddedChannel() === 'production') return false;
  const dev = typeof __DEV__ !== 'undefined' && __DEV__;
  return dev || env.diagnostics;
}

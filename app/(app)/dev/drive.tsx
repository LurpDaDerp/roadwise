import { Redirect } from 'expo-router';

import { HudScreen } from '@/features/drive/HudScreen';

/**
 * `/(app)/dev/drive` — drive diagnostics and the parked simulation (U5, R15). Guarded by
 * `__DEV__ || env.diagnostics`: any other build is sent home. The simulation draws the real HUD
 * as the lockout overlay, which never routes (so a simulated drive never reaches the end screen).
 *
 * The screen is reached through the guarded `require` below, never an import: a release build
 * inlines the flag and `__DEV__`, Metro folds the condition to `false`, and the screen (with its
 * self-test and simulation) is not bundled. Keep the condition spelled out literally in the ternary
 * so it folds. The screen's own guard still sends a production-channel build home.
 */
function SimulationHud() {
  return <HudScreen overlay />;
}

export default function DriveDiagnosticsPage() {
  const Route =
    process.env.EXPO_PUBLIC_DIAGNOSTICS === '1' || __DEV__
      ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- a static import would bundle it in every build
        (require('@/features/dev/DriveDiagnosticsScreen') as typeof import('@/features/dev/DriveDiagnosticsScreen')).DriveDiagnosticsRoute
      : null;
  if (Route === null) return <Redirect href="/" />;
  return <Route Hud={SimulationHud} />;
}

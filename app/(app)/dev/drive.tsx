import { DriveDiagnosticsRoute } from '@/features/dev/DriveDiagnosticsScreen';
import { HudScreen } from '@/features/drive/HudScreen';

/**
 * `/(app)/dev/drive` — drive diagnostics and the parked simulation (U5, R15). Guarded by
 * `__DEV__ || env.diagnostics`: any other build is sent home. The simulation draws the real HUD
 * as the lockout overlay, which never routes (so a simulated drive never reaches the end screen).
 */
function SimulationHud() {
  return <HudScreen overlay />;
}

export default function DriveDiagnosticsPage() {
  return <DriveDiagnosticsRoute Hud={SimulationHud} />;
}

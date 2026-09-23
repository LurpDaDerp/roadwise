import { Redirect } from 'expo-router';
import type { ComponentType } from 'react';

import { diagnosticsEnabled } from '@/features/dev/flags';

/**
 * `/(app)/dev/dms` — DMS diagnostics (plan Task 16, R-2): the live camera pipeline on the real controller
 * and the real privacy gate, with a simulated drive. Guarded like `/(app)/dev/drive`: any build that is not
 * `__DEV__` and was not made with `EXPO_PUBLIC_DIAGNOSTICS=1` is sent home.
 *
 * The panel is reached only through the guarded `require` below, never by an import: a release build inlines
 * the flag and `__DEV__`, Metro folds the condition to `false` before it collects dependencies, and the panel
 * is not bundled (DmsDiagnosticsBundle.test.ts). Keep the condition spelled out literally in the ternary; a
 * helper or a variable would not fold. The native module is bound inside the DMS host (security T14 m-1), so
 * this route never references it.
 */
export default function DmsDiagnosticsPage() {
  const Screen =
    process.env.EXPO_PUBLIC_DIAGNOSTICS === '1' || __DEV__
      ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- a static import would bundle it in every build
        (require('@/features/dev/DmsDiagnosticsPanel') as { DmsDiagnosticsScreen: ComponentType }).DmsDiagnosticsScreen
      : null;
  if (Screen === null || !diagnosticsEnabled()) return <Redirect href="/" />;
  return <Screen />;
}

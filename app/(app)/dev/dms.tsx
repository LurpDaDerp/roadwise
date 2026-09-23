import { Redirect } from 'expo-router';
import type { ComponentType } from 'react';

import { diagnosticsEnabled } from '@/features/dev/flags';

import type { DmsVisionApi } from '../../../modules/dms-vision/src/types';

/**
 * `/(app)/dev/dms` — DMS diagnostics (plan Task 16, R-2): the live camera pipeline on the real controller
 * and the real privacy gate, with a simulated drive. Guarded like `/(app)/dev/drive`: any build that is not
 * `__DEV__` and was not made with `EXPO_PUBLIC_DIAGNOSTICS=1` is sent home.
 *
 * The panel and the native wrapper are reached only through the guarded `require`s below, never by an
 * import: a release build inlines the flag and `__DEV__`, Metro folds the condition to `false` before it
 * collects dependencies, and neither module is bundled (DmsDiagnosticsBundle.test.ts). Keep the condition
 * spelled out literally in the ternary; a helper or a variable would not fold.
 */
export default function DmsDiagnosticsPage() {
  const loaded =
    process.env.EXPO_PUBLIC_DIAGNOSTICS === '1' || __DEV__
      ? {
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- a static import would bundle it in every build
          Screen: (require('@/features/dev/DmsDiagnosticsPanel') as { DmsDiagnosticsScreen: ComponentType<{ native: DmsVisionApi }> }).DmsDiagnosticsScreen,
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
          native: (require('../../../modules/dms-vision') as { default: DmsVisionApi }).default,
        }
      : null;
  if (loaded === null || !diagnosticsEnabled()) return <Redirect href="/" />;
  return <loaded.Screen native={loaded.native} />;
}

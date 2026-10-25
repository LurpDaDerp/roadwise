// DEMO ONLY (temporary): the clock behind the demo cycles, mounted once in the root layout.
import { useEffect } from 'react';

import { advanceDemoDashpal, advanceDemoTheme, DASHPAL_PERIOD_MS, THEME_PERIOD_MS, useDemo } from './demoStore';

export function DemoHost() {
  const { themeCycle, weatherWarning, dashpalCycle } = useDemo();
  // The weather warning holds the theme still: it outranks the cycle.
  const cycling = themeCycle && !weatherWarning;
  useEffect(() => {
    if (!cycling) return;
    const timer = setInterval(advanceDemoTheme, THEME_PERIOD_MS);
    return () => clearInterval(timer);
  }, [cycling]);
  useEffect(() => {
    if (!dashpalCycle) return;
    const timer = setInterval(advanceDemoDashpal, DASHPAL_PERIOD_MS);
    return () => clearInterval(timer);
  }, [dashpalCycle]);
  return null;
}

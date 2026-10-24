import { useEffect, useState } from 'react';

import { AnalyticsScreen } from '@/features/analytics/AnalyticsScreen';
import { AnalyticsLoading } from '@/features/analytics/AnalyticsView';
import { SkyScrollScope } from '@/ui';

/**
 * The Analytics tab: driving scores, coaching, personal bests, metrics and the trip map. Its first
 * frame is the loading screen and the cards build two frames later, so a tap on the tab switches at
 * once: built in the tap's own render (every drive's trend, every trip on the map) the tab froze
 * the tab bar, and the tap read as missed.
 */
export default function AnalyticsRoute() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setReady(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return <SkyScrollScope name="analytics">{ready ? <AnalyticsScreen /> : <AnalyticsLoading />}</SkyScrollScope>;
}

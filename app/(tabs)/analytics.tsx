import { AnalyticsScreen } from '@/features/analytics/AnalyticsScreen';
import { SkyScrollScope } from '@/ui';

/** The Analytics tab: driving scores, coaching, personal bests, metrics and the trip map. */
export default function AnalyticsRoute() {
  return (
    <SkyScrollScope name="analytics">
      <AnalyticsScreen />
    </SkyScrollScope>
  );
}

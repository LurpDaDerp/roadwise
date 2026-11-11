import type { MaterialCommunityIcons } from '@expo/vector-icons';

import type { RoadCondition } from '@/core/road';
import type { HudPalette } from '@/ui/drive';

/**
 * How a weather warning marks its road condition on the driving screen's chip (`EventBanner`): the
 * condition's icon beside the event's, the chip in the condition's colour (a `HudPalette` key, day
 * and night) in place of the tier's, and what a screen reader hears after the chip's words ("Hard
 * brake, wet road"). Every condition in one place.
 */
export interface RoadMark {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  color: 'roadWet' | 'roadWater' | 'roadSnow' | 'roadIce' | 'roadFog';
  spoken: string;
}

export const ROAD_MARK: Readonly<Record<RoadCondition, RoadMark>> = {
  wet: { icon: 'weather-rainy', color: 'roadWet', spoken: 'wet road' },
  water: { icon: 'weather-pouring', color: 'roadWater', spoken: 'heavy rain' },
  snow: { icon: 'weather-snowy', color: 'roadSnow', spoken: 'snowy road' },
  ice: { icon: 'snowflake', color: 'roadIce', spoken: 'icy road' },
  fog: { icon: 'weather-fog', color: 'roadFog', spoken: 'low visibility' },
};

/** Every road condition a weather warning can carry. */
export const ROAD_CONDITIONS = Object.keys(ROAD_MARK) as RoadCondition[];

/** The chip colour of a road condition in palette `p`. */
export const roadColor = (p: HudPalette, road: RoadCondition): string => p[ROAD_MARK[road].color];

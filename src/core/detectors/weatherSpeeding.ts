// The weather "Slow down" (product spec "Weather"): an alert-only watch beside the speeding
// detector. It never makes an event and never touches a score: speeding is judged at the posted
// limit alone (`speeding.ts`), whatever the weather.
//
// A row the host stamped with a road state that lowers the limit (`row.road`: a wet, snowy or icy
// road, low visibility; `judgedLimitMph` under the posted limit) is watched against that lower
// limit's speeding line, with the speeding detector's usability rules (a posted limit on a confident
// match, a trusted speed, a good fix). An over row opens a stretch; the stretch ends, like a speeding
// episode, after `SPEEDING_END_S` rows in a row back under its line less `SPEEDING_END_BUFFER_MPH`
// or without a usable stamped row (hovering in the buffer neither extends nor ends it). The engine
// alerts once per stretch, only when no speeding episode is open, and holds the band's weather
// "Slow down" while the row is over the weather line and not over the speeding line
// (`machine.ts`).
//
// Its stretch ids are its own (`wx-speeding-<first over row ts>`): it never takes an event id, so
// the events' ids are the same with or without the weather.
import { speedingLine, speedTier, SPEEDING_END_BUFFER_MPH, SPEEDING_END_S } from '@scoring';

import { judgedLimitMph, speedingCondition, type RoadCondition } from '@/core/road';

import type { FeatureRow, LimitSample, WeatherSpeedingStretch } from '../engine/types';
import { gnssPoor, knownSpeedMph, limitMphFor, speedTrusted } from './common';

interface Stretch {
  id: string;
  startedAt: number;
  /** The condition of the latest over row. */
  road: RoadCondition;
  /** Consecutive rows back under the line less the buffer (or without a usable stamped row). */
  belowRows: number;
  /** The current row is over the weather line. */
  over: boolean;
  /** mph past the weather line on the current row (0 when not over). */
  overMph: number;
}

export interface WeatherSpeedingWatch {
  /** Watch one row (with the limit the detectors were given). */
  push(row: FeatureRow, limit: LimitSample): void;
  /** Drop the stretch (trip end). */
  flush(): void;
  /** The stretch in progress (its end window included), or null. */
  stretch(): WeatherSpeedingStretch | null;
}

export function createWeatherSpeedingWatch(): WeatherSpeedingWatch {
  let st: Stretch | null = null;

  return {
    push(row, limit) {
      const limitMph = limitMphFor(row, limit);
      const speedMph = knownSpeedMph(row);
      const usable = limitMph !== null && speedMph !== null && speedTrusted(row) && !gnssPoor(row);
      // The condition that lowers the limit, and the lower limit: null on a row it does not watch.
      const road = usable ? speedingCondition(limitMph, row.road) : null;
      const judged = usable && road !== null ? judgedLimitMph(limitMph, row.road) : null;
      const line = judged === null ? null : speedingLine(judged);

      if (road !== null && judged !== null && line !== null && speedMph !== null && speedTier(speedMph, judged) !== null) {
        if (st === null) st = { id: `wx-speeding-${row.ts}`, startedAt: row.ts, road, belowRows: 0, over: true, overMph: 0 };
        st.road = road;
        st.belowRows = 0;
        st.over = true;
        st.overMph = speedMph - line;
        return;
      }

      if (st === null) return;
      st.over = false;
      st.overMph = 0;
      const under = line === null || speedMph === null || speedMph < line - SPEEDING_END_BUFFER_MPH;
      st.belowRows = under ? st.belowRows + 1 : 0;
      if (st.belowRows >= SPEEDING_END_S) st = null;
    },
    flush() {
      st = null;
    },
    stretch() {
      if (st === null) return null;
      return { id: st.id, startedAt: st.startedAt, road: st.road, over: st.over, overMph: st.overMph };
    },
  };
}

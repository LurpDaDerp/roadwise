import type { SpeedTrace } from '@/core/engine/speedTrace';

import { drive, event } from '../__fixtures__/drives';
import {
  axisLabels,
  chartSpanS,
  chartTop,
  limitPath,
  linePath,
  showsSpeedChart,
  SPEED_BAND_MIN_W,
  speedChartLabel,
  speedingBands,
  speedRuns,
  xAt,
  yAt,
  type ChartScale,
} from '../speedChartModel';

/** 5 s buckets: 30 and 32 mph under a 25 limit, a bucket with no speed, then 40 and 41 under 35 and no sign. */
const TRACE: SpeedTrace = {
  widthS: 5,
  points: [
    { t: 0, v: 30, l: 25 },
    { t: 5, v: 32, l: 25 },
    { t: 10, v: null, l: 25 },
    { t: 15, v: 40, l: 35 },
    { t: 20, v: 41, l: null },
  ],
};

/** A plot 100 × 100 inside its 4 pt edges, 25 s across, 0 to 50 mph: x = 4 + 4 s, y = 104 − 2 v. */
const SC: ChartScale = { spanS: 25, top: 50, width: 108, height: 108, units: 'mi' };

describe('when the chart shows', () => {
  test('from two points with a speed', () => {
    expect(showsSpeedChart(TRACE)).toBe(true);
    expect(showsSpeedChart({ widthS: 5, points: [{ t: 0, v: 20, l: null }, { t: 5, v: null, l: 25 }] })).toBe(false);
    expect(showsSpeedChart({ widthS: 5, points: [] })).toBe(false);
  });

  test('never without a trace (a drive recorded before it, a restored one)', () => {
    expect(showsSpeedChart(null)).toBe(false);
    expect(showsSpeedChart(undefined)).toBe(false);
  });
});

describe('the axes', () => {
  test('X spans the drive, never shorter than the trace, at least a second', () => {
    expect(chartSpanS({ durationS: 25 }, TRACE)).toBe(25);
    expect(chartSpanS({ durationS: 12 }, TRACE)).toBe(21);
    expect(chartSpanS({ durationS: 0 }, { widthS: 5, points: [{ t: 0, v: 1, l: null }] })).toBe(1);
  });

  test('Y tops out at the fastest speed or limit, rounded up to the next 10', () => {
    expect(chartTop(TRACE, 'mi')).toBe(50);
    expect(chartTop({ widthS: 5, points: [{ t: 0, v: 38, l: 40 }] }, 'mi')).toBe(40);
    expect(chartTop({ widthS: 5, points: [{ t: 0, v: 62.3, l: 55 }] }, 'mi')).toBe(70);
    expect(chartTop({ widthS: 5, points: [{ t: 0, v: 0, l: null }] }, 'mi')).toBe(10);
  });

  test('in km/h for a kilometre driver', () => {
    // 41 mph is 66 km/h.
    expect(chartTop(TRACE, 'km')).toBe(70);
    expect(axisLabels(70, 'km')).toEqual(['70 km/h', '35 km/h', '0 km/h']);
  });

  test('three labels, top to bottom, with units', () => {
    expect(axisLabels(50, 'mi')).toEqual(['50 mph', '25 mph', '0 mph']);
  });

  test('points land inside the plot, clamped to it', () => {
    expect(xAt(0, SC)).toBe(4);
    expect(xAt(25, SC)).toBe(104);
    expect(xAt(-3, SC)).toBe(4);
    expect(xAt(99, SC)).toBe(104);
    expect(yAt(50, SC)).toBe(4);
    expect(yAt(0, SC)).toBe(104);
    expect(yAt(80, SC)).toBe(4);
    // A kilometre driver's plot reads km/h: 25 mph is 40.2 km/h of 50.
    expect(yAt(25, { ...SC, units: 'km' })).toBeCloseTo(4 + (1 - (25 * 1.609344) / 50) * 100, 6);
  });
});

describe('the speed line', () => {
  test('one run per stretch with a speed, each point in its bucket middle; a bucket with none breaks it', () => {
    const rounded = speedRuns(TRACE, SC).map((run) => run.map((p) => ({ x: +p.x.toFixed(6), y: +p.y.toFixed(6) })));
    expect(rounded).toEqual([
      [
        { x: 14, y: 44 },
        { x: 34, y: 40 },
      ],
      [
        { x: 74, y: 24 },
        { x: 94, y: 22 },
      ],
    ]);
  });

  test('missing rows between two buckets break it too', () => {
    const gap: SpeedTrace = { widthS: 5, points: [{ t: 0, v: 20, l: null }, { t: 5, v: 20, l: null }, { t: 20, v: 20, l: null }] };
    expect(speedRuns(gap, SC).map((r) => r.length)).toEqual([2, 1]);
  });

  test('the last bucket\'s middle never passes the drive\'s end', () => {
    const runs = speedRuns(TRACE, { ...SC, spanS: 21 });
    expect(runs[1]![1]!.x).toBe(104);
  });

  test('a straight path through the points', () => {
    expect(linePath([{ x: 1, y: 2 }, { x: 3.25, y: 4 }])).toBe('M1.0,2.0 L3.3,4.0');
    expect(linePath([])).toBe('');
  });
});

describe('the limit', () => {
  test('flat across each bucket, stepping between neighbours, broken where no sign was seen', () => {
    // 25 mph from 0 to 15 s (y 54), then 35 mph (y 34) to 20 s; the last bucket has no sign.
    expect(limitPath(TRACE, SC)).toBe('M4.0,54.0 L24.0,54.0 L24.0,54.0 L44.0,54.0 L44.0,54.0 L64.0,54.0 L64.0,34.0 L84.0,34.0');
  });

  test('a stretch with no limit starts the next one afresh', () => {
    const t: SpeedTrace = { widthS: 5, points: [{ t: 0, v: 20, l: 25 }, { t: 5, v: 20, l: null }, { t: 10, v: 20, l: 25 }] };
    expect(limitPath(t, SC)).toBe('M4.0,54.0 L24.0,54.0 M44.0,54.0 L64.0,54.0');
  });

  test('none at all: no path', () => {
    expect(limitPath({ widthS: 5, points: [{ t: 0, v: 20, l: null }] }, SC)).toBe('');
  });
});

describe('the speeding bands', () => {
  const d = drive();
  const at = (s: number) => d.startedAt + s * 1000;

  test('each active speeding episode from its start for as long as it lasted, in its tier', () => {
    const bands = speedingBands(d, [event({ id: 's1', type: 'speeding', tier: 'moderate', startedAt: at(15), durationS: 5 })], SC);
    expect(bands).toEqual([{ id: 's1', tier: 'moderate', x: 64, width: 20 }]);
  });

  test('removed or accepted reports, and other events, draw none', () => {
    const events = [
      event({ id: 'a', type: 'speeding', startedAt: at(5), durationS: 5, removed: true }),
      event({ id: 'b', type: 'speeding', startedAt: at(5), durationS: 5, disputeStatus: 'accepted' }),
      event({ id: 'c', type: 'hard_brake', startedAt: at(5), durationS: 1 }),
    ];
    expect(speedingBands(d, events, SC)).toEqual([]);
  });

  test('clamped to the drive; an episode wholly outside it draws none; a short one keeps a minimum width', () => {
    const events = [
      event({ id: 'early', type: 'speeding', startedAt: at(-10), durationS: 5 }),
      event({ id: 'late', type: 'speeding', startedAt: at(30), durationS: 5 }),
      event({ id: 'into', type: 'speeding', startedAt: at(-5), durationS: 10 }),
      event({ id: 'blip', type: 'speeding', startedAt: at(10), durationS: 0 }),
      event({ id: 'end', type: 'speeding', startedAt: at(25), durationS: 0 }),
    ];
    expect(speedingBands(d, events, SC)).toEqual([
      { id: 'into', tier: 'minor', x: 4, width: 20 },
      { id: 'blip', tier: 'minor', x: 44, width: SPEED_BAND_MIN_W },
      { id: 'end', tier: 'minor', x: 104, width: SPEED_BAND_MIN_W },
    ]);
  });
});

describe('what a screen reader hears', () => {
  test('how often and how long the drive was over the limit', () => {
    const s = (id: string, durationS: number, over = {}) => event({ id, type: 'speeding', durationS, ...over });
    expect(speedChartLabel([s('a', 30), s('b', 25), s('c', 15)])).toBe('Speed chart. Over the limit 3 times, 1 minute 10 seconds in all.');
    expect(speedChartLabel([s('a', 12)])).toBe('Speed chart. Over the limit once, 12 seconds in all.');
  });

  test('never over: says so; removed episodes and other events do not count', () => {
    expect(speedChartLabel([])).toBe('Speed chart. Never over the limit.');
    expect(speedChartLabel([event(), event({ id: 'x', type: 'speeding', durationS: 9, removed: true })])).toBe('Speed chart. Never over the limit.');
  });
});

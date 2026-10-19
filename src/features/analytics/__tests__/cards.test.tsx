import { screen, within } from '@testing-library/react-native';
import type { ComponentType, ReactNode } from 'react';
import { StyleSheet, View, type TextStyle, type ViewStyle } from 'react-native';

import { publishUnits, resetUnitsForTests } from '@/data/queries/units';
import { draw, drive, HOUR, NOW, press } from '@/features/drives/__fixtures__/drives';
import { setMapsForTests, type MapsModule } from '@/features/settings/maps';
import { contrastRatio, mix } from '@/ui';
import { ThemeProvider } from '@/ui/theme';
import { tokens } from '@/ui/tokens';

import { drives, NO_SCORES, SCORES } from '../__fixtures__/analytics';
import { BestsCard } from '../BestsCard';
import { DRIVES_PAGE, DrivesCard, driveLine } from '../DrivesCard';
import { metricGroups, metricsBlockHeight, MetricsCards, metricsLayout, METRICS_MAX_SHARE } from '../MetricsCards';
import { coach, driveGrid, EMPTY_TREND, EMPTY_WINDOW, fitLines, personalBests, trend, windowSums, type MapPoint } from '../model';
import { RADAR_LABEL_MAX_SCALE, radarGeometry, radarLabel, radarPoint, radarPolygon, RadarCard } from '../RadarCard';
import { SummaryCard } from '../SummaryCard';
import { chartBoxHeight, monotonePath, PLOT_EDGE, plotPoint, trendLabel, trendValue, visibleTicks } from '../TrendCard';
import { TripsMapCard } from '../TripsMapCard';
import { bandSpan, busiest, cellAlpha, WhenYouDriveCard } from '../WhenYouDriveCard';

const light = tokens.color.light;

const mockWindow = jest.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 1 }));
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockWindow() }));
const setWindow = (width: number, height: number, fontScale = 1) => mockWindow.mockReturnValue({ width, height, scale: 3, fontScale });

afterEach(() => {
  resetUnitsForTests();
  setMapsForTests(undefined);
  setWindow(390, 844);
});

type El = ReturnType<typeof screen.getByTestId>;
const flat = (el: El): ViewStyle & TextStyle => StyleSheet.flatten(el.props.style) ?? {};

describe('RadarCard', () => {
  test('the Safety Rating sits in the middle as a whole number, with every axis and its score around it', async () => {
    await draw(<RadarCard rating={92.4} scores={SCORES} />);
    expect(screen.getByTestId('radar-rating')).toHaveTextContent('92');
    expect(screen.getByTestId('radar-out-of')).toHaveTextContent('/100');
    expect(screen.getByText('Safety Rating')).toBeOnTheScreen();
    // a card-coloured halo keeps the shape's lines out of the centre number
    expect(screen.getByTestId('radar-rating')).toHaveStyle({ textShadowColor: light.surface });
    expect(screen.getAllByTestId(/^radar-dot-/, { includeHiddenElements: true })).toHaveLength(6);
    for (const [label, score] of [
      ['Speeding', '88'],
      ['Braking', '72'],
      ['Acceleration', '95'],
      ['Cornering', '100'],
      ['Phone use', '60'],
      ['Clean drives', '50'],
    ]) {
      expect(screen.getByText(label!)).toBeOnTheScreen();
      expect(screen.getByText(score!)).toBeOnTheScreen();
    }
    expect(screen.getByText('Last 30 days')).toBeOnTheScreen();
  });

  test('one summary label for a screen reader lists the rating and every axis', async () => {
    await draw(<RadarCard rating={92.4} scores={SCORES} />);
    const label = 'Safety Rating 92 out of 100. Speeding 88, Braking 72, Acceleration 95, Cornering 100, Phone use 60, Clean drives 50.';
    expect(screen.getByLabelText(label)).toBeOnTheScreen();
    expect(screen.getByLabelText(label).props.accessibilityRole).toBe('image');
  });

  test('no rating and no data: dashes everywhere, the shape folds to the centre', async () => {
    await draw(<RadarCard rating={null} scores={NO_SCORES} />);
    expect(screen.getByTestId('radar-rating')).toHaveTextContent('—');
    expect(screen.queryByTestId('radar-out-of')).toBeNull();
    expect(screen.getAllByText('—')).toHaveLength(7);
    // no dots pile up under the dash for axes with no score
    expect(screen.queryAllByTestId(/^radar-dot-/, { includeHiddenElements: true })).toHaveLength(0);
    expect(radarLabel(null, NO_SCORES)).toBe(
      'Safety Rating, no score yet. Speeding no data, Braking no data, Acceleration no data, Cornering no data, Phone use no data, Clean drives no data.'
    );
    expect(radarPolygon([null, null, null, null, null, null], 100, { x: 150, y: 150 })).toBe(Array(6).fill('150.0,150.0').join(' '));
  });

  test('geometry: the first axis points straight up, the hexagon runs clockwise', () => {
    const c = { x: 100, y: 100 };
    expect(radarPoint(0, 6, 50, c)).toEqual({ x: 100, y: 50 });
    const p1 = radarPoint(1, 6, 50, c);
    expect(p1.x).toBeGreaterThan(100);
    expect(p1.y).toBeCloseTo(75);
    expect(radarPoint(3, 6, 50, c).y).toBeCloseTo(150);
    expect(radarPolygon([100, 50, 0, 0, 0, 0], 100, c).split(' ')[0]).toBe('100.0,0.0');
    expect(radarPolygon([140, 50, 0, 0, 0, 0], 100, c).split(' ')[0]).toBe('100.0,0.0');
  });

  const overlaps = (a: { left: number; top: number; width: number; height: number }, b: typeof a) =>
    a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

  test.each([
    [326, 1],
    [256, 1],
    [326, RADAR_LABEL_MAX_SCALE],
    [256, RADAR_LABEL_MAX_SCALE],
  ])('labels sit wholly outside the hexagon and inside the chart (width %d, text %d×)', (width, scale) => {
    const g = radarGeometry(width, scale);
    const pts = Array.from({ length: 6 }, (_, i) => radarPoint(i, 6, g.r, g.c));
    const hex = {
      minX: Math.min(...pts.map((p) => p.x)),
      maxX: Math.max(...pts.map((p) => p.x)),
      minY: Math.min(...pts.map((p) => p.y)),
      maxY: Math.max(...pts.map((p) => p.y)),
    };
    const [top, upRight, downRight, bottom, downLeft, upLeft] = g.labels;
    expect(top!.top + top!.height).toBeLessThanOrEqual(hex.minY - 1);
    expect(bottom!.top).toBeGreaterThanOrEqual(hex.maxY + 1);
    for (const b of [upRight!, downRight!]) {
      expect(b.left).toBeGreaterThanOrEqual(hex.maxX + 1);
      expect(b.align).toBe('left');
    }
    for (const b of [downLeft!, upLeft!]) {
      expect(b.left + b.width).toBeLessThanOrEqual(hex.minX - 1);
      expect(b.align).toBe('right');
    }
    for (const b of g.labels) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.top).toBeGreaterThanOrEqual(0);
      expect(b.left + b.width).toBeLessThanOrEqual(g.width);
      expect(b.top + b.height).toBeLessThanOrEqual(g.height);
    }
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) expect(overlaps(g.labels[i]!, g.labels[j]!)).toBe(false);
  });

  test('the drawn labels follow the geometry and stop growing at 1.3× text', async () => {
    setWindow(390, 844, 2);
    await draw(<RadarCard rating={80} scores={SCORES} />);
    const box = radarGeometry(390 - 4 * tokens.space.lg, RADAR_LABEL_MAX_SCALE).labels[2]!;
    expect(flat(screen.getByTestId('radar-axis-accel'))).toMatchObject({ left: box.left, top: box.top, width: box.width, height: box.height });
    expect(flat(screen.getByText('Acceleration')).fontSize).toBeCloseTo(tokens.type.caption.fontSize * RADAR_LABEL_MAX_SCALE);
    expect(flat(screen.getByText('95')).fontSize).toBeCloseTo(tokens.type.subhead.fontSize * RADAR_LABEL_MAX_SCALE);
  });

  test('the chart ink is monotone: the page ink, no signal colours', async () => {
    await draw(<RadarCard rating={80} scores={SCORES} />);
    expect(screen.getByTestId('radar-rating')).toHaveStyle({ color: light.text });
    expect(screen.getByText('Speeding')).toHaveStyle({ color: light.textMuted });
  });
});

describe('SummaryCard', () => {
  test('a weak axis: its level icon in its colour, the title and the tip, with the level word spoken', async () => {
    await draw(<SummaryCard coaching={coach(SCORES, { drives: 4, miles: 48 })} />);
    expect(screen.getByText('Phone down while driving')).toBeOnTheScreen();
    expect(screen.getByText('Put the phone away before you pull out.')).toBeOnTheScreen();
    expect(screen.getByTestId('analytics-summary-icon')).toHaveStyle({ color: light.warning });
    expect(screen.getByLabelText('Fair. Phone down while driving. Put the phone away before you pull out. Also watch: Braking, fair.')).toBeOnTheScreen();
  });

  test('the other weak areas sit under the tip as small level icons with their names, weakest first', async () => {
    const c = coach({ ...SCORES, braking: 72, speeding: 55, phone: 40 }, { drives: 4, miles: 48 });
    await draw(<SummaryCard coaching={c} />);
    const row = screen.getByTestId('analytics-summary-also');
    expect(StyleSheet.flatten(row.props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
    expect(within(row).getByText('Speeding')).toBeOnTheScreen();
    expect(within(row).getByText('Braking')).not.toHaveProp('numberOfLines');
    expect(screen.getByTestId('analytics-summary-also-speeding-icon')).toHaveStyle({ color: light.danger, fontSize: tokens.size.iconSm });
    expect(screen.getByTestId('analytics-summary-also-braking-icon')).toHaveStyle({ color: light.warning, fontSize: tokens.size.iconSm });
    expect(screen.getByLabelText(/Also watch: Speeding, poor\. Braking, fair\.$/)).toBeOnTheScreen();
  });

  test('no row when nothing else needs watching', async () => {
    await draw(<SummaryCard coaching={coach({ ...SCORES, braking: 90 }, { drives: 4, miles: 48 })} />);
    expect(screen.queryByTestId('analytics-summary-also')).toBeNull();
    expect(screen.getByLabelText('Fair. Phone down while driving. Put the phone away before you pull out.')).toBeOnTheScreen();
  });

  test('good driving gets a compliment and a green check', async () => {
    const good = { speeding: 95, braking: 90, accel: 99, cornering: 100, phone: 100, clean: 90 };
    await draw(<SummaryCard coaching={coach(good, { drives: 5, miles: 40 })} />);
    expect(screen.getByText('Driving well')).toBeOnTheScreen();
    expect(screen.getByText('Smooth driving lately. Keep it up.')).toBeOnTheScreen();
    expect(screen.getByTestId('analytics-summary-icon')).toHaveStyle({ color: light.success });
    expect(screen.getByLabelText('Good. Driving well. Smooth driving lately. Keep it up.')).toBeOnTheScreen();
  });

  test('not enough driving yet: a short wait line, no level', async () => {
    await draw(<SummaryCard coaching={coach(NO_SCORES, { drives: 0, miles: 0 })} />);
    expect(screen.getByLabelText('Tips are on the way. Drive a few more times to get tips here.')).toBeOnTheScreen();
  });
});

describe('BestsCard', () => {
  const list = [
    drive({ clientTripId: 'big', pointsNet: 310, miles: 9, clean: false }),
    drive({ clientTripId: 'long', pointsNet: 120, miles: 31.24, clean: true, counts: { ...drive().counts, hardBrake: 0 } }),
    drive({ clientTripId: 'phone', pointsNet: 80, miles: 18, counts: { ...drive().counts, pickups: 2 } }),
  ];

  test('one row of three, each opening its drive', async () => {
    const onOpen = jest.fn();
    await draw(<BestsCard bests={personalBests(list)} onOpen={onOpen} />);
    expect(screen.getByText('Personal bests')).toBeOnTheScreen();
    expect(screen.getByTestId('best-points-value')).toHaveTextContent('+310 pts');
    expect(screen.getByTestId('best-clean-value')).toHaveTextContent('31.2 mi');
    expect(screen.getByTestId('best-phone-free-value')).toHaveTextContent('31.2 mi');
    expect(screen.getByLabelText('Most points, plus 310 points')).toBeOnTheScreen();
    await press(screen.getByTestId('best-points'));
    expect(onOpen).toHaveBeenCalledWith('big');
  });

  test('in kilometres when the driver uses them', async () => {
    publishUnits('km');
    await draw(<BestsCard bests={personalBests(list)} onOpen={jest.fn()} />);
    expect(screen.getByTestId('best-clean-value')).toHaveTextContent('50.3 km');
  });

  test('no drives yet: dashes, nothing to press', async () => {
    await draw(<BestsCard bests={personalBests([])} onOpen={jest.fn()} />);
    expect(screen.getAllByText('—')).toHaveLength(3);
    expect(screen.getByTestId('best-points').props.accessibilityRole).toBeUndefined();
    expect(screen.getByLabelText('Phone-free, none yet')).toBeOnTheScreen();
  });
});

describe('MetricsCards', () => {
  test('three cards: Driving, the Trend over the event counts, Phone & points, with per-drive averages', async () => {
    const sums = windowSums(drives(4), null);
    await draw(<MetricsCards sums={sums} trend={EMPTY_TREND} />);
    for (const title of ['Driving', 'Trend', 'Phone & points']) expect(screen.getByText(title)).toBeOnTheScreen();
    expect(screen.queryByTestId('metrics-events')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Events' })).toBeOnTheScreen();
    expect(metricGroups(sums, 'mi').map((g) => g.cells.map((c) => c.caption))).toEqual([
      ['Drives', 'Distance', 'Avg drive', 'Avg speed'],
      ['Speeding', 'Hard brakes', 'Hard starts', 'Sharp turns'],
      ['Pickups', 'Phone time', 'Clean drives', 'Avg points'],
    ]);
    expect(screen.getByTestId('metric-drives-value')).toHaveTextContent('4');
    expect(screen.getByTestId('metric-distance-value')).toHaveTextContent('48.0 mi');
    expect(screen.getByTestId('metric-avg-drive-value')).toHaveTextContent('12.0 mi');
    expect(screen.getByTestId('metric-speed-value')).toHaveTextContent('30 mph');
    expect(screen.getByTestId('metric-brakes-value')).toHaveTextContent('4');
    expect(screen.getByTestId('metric-clean-value')).toHaveTextContent('0 %');
    expect(screen.getByTestId('metric-avg-points-value')).toHaveTextContent('+132 pts');
    expect(screen.getByLabelText('Distance, 48.0 miles')).toBeOnTheScreen();
    expect(screen.getByLabelText('Avg drive, 12.0 miles')).toBeOnTheScreen();
    expect(screen.getByLabelText('Avg points, plus 132 points')).toBeOnTheScreen();
    expect(metricGroups(sums, 'km')[0]!.cells[2]!.metric).toMatchObject({ value: '19.3', unit: 'km' });
  });

  test('an empty range reads as zeros and dashes', async () => {
    await draw(<MetricsCards sums={EMPTY_WINDOW} trend={EMPTY_TREND} />);
    expect(screen.getByTestId('metric-drives-value')).toHaveTextContent('0');
    expect(screen.getByTestId('metric-distance-value')).toHaveTextContent('0.0 mi');
    expect(screen.getByTestId('metric-avg-drive-value')).toHaveTextContent('— mi');
    expect(screen.getByTestId('metric-speed-value')).toHaveTextContent('— mph');
    expect(screen.getByTestId('metric-clean-value')).toHaveTextContent('— %');
    expect(screen.getByTestId('metric-avg-points-value')).toHaveTextContent('— pts');
    expect(screen.getByLabelText('Avg points, no data')).toBeOnTheScreen();
    // a zero-drive range from real data reads the same: no NaN or Infinity
    for (const c of metricGroups(windowSums([], null), 'km').flatMap((g) => g.cells)) expect(c.metric.value).not.toMatch(/NaN|Infinity/);
  });

  /**
   * The block's height as drawn, read off the rendered tree: each card's padding, its title's line,
   * and per row the card gap plus the tallest cell (number line + cell gap + caption line); then the
   * gaps between the cards. The trend card counts its header row (the title or the picker, the
   * taller), its chart box and its row of counts. The lines are the rendered `lineHeight`s and
   * heights, so this follows whatever sizes and spacing the cards actually use.
   */
  const cellsIn = (row: El) => within(row).getAllByTestId(/^metric-(?!.*-(value|caption)$)[a-z-]+$/);
  const rowHeight = (row: El) =>
    Math.max(
      ...cellsIn(row).map((cell) => {
        const id = String(cell.props.testID);
        const value = Number(flat(screen.getByTestId(`${id}-value`)).lineHeight);
        const captionEl = screen.getByTestId(`${id}-caption`);
        const caption = Number(flat(captionEl).lineHeight) * Number(captionEl.props.numberOfLines ?? 1);
        return value + Number(flat(cell).gap ?? 0) + caption;
      })
    );
  function drawnHeight(): number {
    const cards = (['driving', 'events', 'phone'] as const).map((key) => {
      const trendCard = key === 'events' ? screen.queryByTestId('metrics-trend') : null;
      if (trendCard) {
        const card = flat(trendCard);
        const gap = Number(card.gap ?? 0);
        const header = Math.max(
          Number(flat(screen.getByTestId('metrics-trend-title')).lineHeight),
          Number(flat(screen.getByTestId('metrics-trend-picker')).minHeight)
        );
        expect(flat(screen.getByTestId('metrics-trend-header')).minHeight).toBe(header);
        const chart = Number(flat(screen.getByTestId('trend-chart-box')).height);
        return Number(card.padding ?? 0) * 2 + header + gap + chart + gap + rowHeight(screen.getByTestId('metrics-trend-row-0'));
      }
      const card = flat(screen.getByTestId(`metrics-${key}`));
      const gap = Number(card.gap ?? 0);
      const title = Number(flat(screen.getByTestId(`metrics-${key}-title`)).lineHeight);
      const rows = screen.getAllByTestId(new RegExp(`^metrics-${key}-row-`));
      const rowsH = rows.reduce((sum, row) => sum + gap + rowHeight(row), 0);
      return Number(card.padding ?? 0) * 2 + title + rowsH;
    });
    const blockGap = Number(flat(screen.getByTestId('analytics-metrics')).gap ?? 0);
    return cards.reduce((a, b) => a + b, 0) + blockGap * (cards.length - 1);
  }

  test.each([
    ['390 × 844', 390, 844, 1],
    ['430 × 932', 430, 932, 1],
    ['375 × 667 (iPhone SE)', 375, 667, 1],
    ['360 × 740', 360, 740, 1],
    ['360 × 640', 360, 640, 1],
    ['320 × 568', 320, 568, 1],
    ['390 × 844 at 1.3× text', 390, 844, 1.3],
    ['390 × 844 at 1.5× text', 390, 844, 1.5],
    ['390 × 844 at 2× text', 390, 844, 2],
    ['430 × 932 at 2× text', 430, 932, 2],
    ['375 × 667 at 2× text', 375, 667, 2],
    ['360 × 640 at 3× text', 360, 640, 3],
    ['320 × 568 at 2× text', 320, 568, 2],
  ])('the whole metrics block takes at most three quarters of a %s window', async (_name, width, height, fontScale) => {
    setWindow(width, height, fontScale);
    await draw(<MetricsCards sums={windowSums(drives(4), null)} trend={trend(drives(4), [], 'week', NOW)} />);
    const drawn = drawnHeight();
    expect(drawn).toBeLessThanOrEqual(height * METRICS_MAX_SHARE);
    // The layout model agrees with what was drawn.
    const l = metricsLayout(height, Math.min(fontScale, 2));
    expect(metricsBlockHeight(l)).toBeCloseTo(drawn, 5);
    expect(screen.getAllByTestId(/^metric-[a-z-]+-value$/)).toHaveLength(12);
    // With room, the chart is drawn at the plot height the layout gave it.
    if (l.plot > 0) expect(screen.getByTestId('trend-chart').props.height).toBe(l.plot);
    else expect(screen.queryByTestId('metrics-trend')).toBeNull();
  });

  test('the chart takes the room left: standard cards on a big phone, tighter ones on most, a row of four on short ones', async () => {
    expect(metricsLayout(932, 1)).toMatchObject({ name: 'grid', perRow: 2, textScale: 1, plot: 120 });
    expect(metricsBlockHeight(metricsLayout(932, 1))).toBe(690);
    expect(metricsLayout(844, 1)).toMatchObject({ name: 'compact', perRow: 2, textScale: 1, plot: 96 });
    expect(metricsBlockHeight(metricsLayout(844, 1))).toBe(594);
    expect(metricsLayout(740, 1)).toMatchObject({ name: 'compact', plot: 57 });
    expect(metricsLayout(667, 1)).toMatchObject({ name: 'row', perRow: 4, textScale: 1, plot: 78 });
    expect(metricsLayout(640, 1)).toMatchObject({ name: 'row', plot: 58 });
    expect(metricsLayout(844, 1.3)).toMatchObject({ name: 'row', textScale: 1.3, plot: 80 });
  });

  test('no room for the chart: the middle card is the event counts, and the text size comes first', async () => {
    // The shortest phone: the counts alone, as a row of four.
    expect(metricsLayout(568, 1)).toMatchObject({ name: 'row', textScale: 1, plot: 0 });
    expect(metricsBlockHeight(metricsLayout(568, 1))).toBe(382);
    // 2× text keeps its size and drops the chart.
    expect(metricsLayout(844, 2)).toMatchObject({ name: 'row', perRow: 4, textScale: 2, plot: 0 });
    // Too tall even as a row: the block's text stops growing where it fits, never below 1×.
    const capped = metricsLayout(640, 2);
    expect(capped).toMatchObject({ name: 'row', plot: 0 });
    expect(capped.textScale).toBeLessThan(2);
    expect(capped.textScale).toBeGreaterThanOrEqual(1);
    expect(metricsBlockHeight(capped)).toBeLessThanOrEqual(480);

    setWindow(390, 844, 2);
    await draw(<MetricsCards sums={EMPTY_WINDOW} trend={EMPTY_TREND} />);
    expect(screen.getAllByTestId(/^metrics-driving-row-/)).toHaveLength(1);
    expect(cellsIn(screen.getByTestId('metrics-driving-row-0'))).toHaveLength(4);
    expect(screen.queryByTestId('metrics-trend')).toBeNull();
    expect(screen.getByTestId('metrics-events-title')).toHaveTextContent('Events');
    expect(cellsIn(screen.getByTestId('metrics-events-row-0'))).toHaveLength(4);
  });

  test('large text never draws a number or caption smaller than 1×: the row of four wraps its captions to two lines, and every fit has a floor', async () => {
    setWindow(390, 844, 2);
    await draw(<MetricsCards sums={windowSums(drives(4), null)} trend={trend(drives(4), [], 'week', NOW)} />);
    for (const el of screen.getAllByTestId(/^metric-[a-z-]+-caption$/)) {
      expect(el.props).toMatchObject({ numberOfLines: 2, minimumFontScale: 0.85 });
      // 14 pt label at 2×, floored at 0.85: still above the 14 pt it is at 1×
      expect(Number(flat(el).fontSize) * Number(el.props.minimumFontScale)).toBeGreaterThan(tokens.type.label.fontSize);
    }
    for (const el of screen.getAllByTestId(/^metric-[a-z-]+-value$/)) expect(el.props.minimumFontScale).toBe(0.7);
    setWindow(390, 844, 1);
    await draw(<MetricsCards sums={windowSums(drives(4), null)} trend={trend(drives(4), [], 'week', NOW)} />);
    expect(screen.getByTestId('metric-clean-caption').props.numberOfLines).toBe(1);
    await draw(<BestsCard bests={personalBests([])} onOpen={jest.fn()} />);
    expect(screen.getByTestId('best-clean-caption').props).toMatchObject({ numberOfLines: 2, minimumFontScale: 0.85 });
  });

  test('at 390 × 844 a 2 × 2 cell has room for "1,204 mi" in the display face', () => {
    // Half the card's inner width (the tighter cards there), less the gap between the two cells.
    const { pad, colGap } = metricsLayout(844, 1);
    expect((390 - 2 * tokens.space.lg - 2 * pad - colGap) / 2).toBeGreaterThanOrEqual(150);
  });
});

describe('TrendCard', () => {
  // NOW is Monday 15:00. Sunday: 30 mi, two hard brakes, +90; Monday: 10 mi, none, +150.
  const list = [
    drive({ clientTripId: 'm', startedAt: NOW - 2 * HOUR, miles: 10, pointsNet: 150, counts: { ...drive().counts, hardBrake: 0 } }),
    drive({ clientTripId: 's', startedAt: NOW - 20 * HOUR, miles: 30, pointsNet: 90, counts: { ...drive().counts, hardBrake: 2, speeding: 1 } }),
  ];
  const brakes = [
    { id: 'b1', type: 'hard_brake' as const, tier: 'severe' as const, startedAt: NOW - 20 * HOUR + 60_000, durationS: 0, status: 'active' as const },
    { id: 'b2', type: 'hard_brake' as const, tier: 'severe' as const, startedAt: NOW - 20 * HOUR + 120_000, durationS: 0, status: 'active' as const },
  ];
  const data = trend(list, brakes, 'week', NOW);

  test('Score by default: one line in the page ink, a dot per day, the latest labelled, weekday ticks', async () => {
    await draw(<MetricsCards sums={windowSums(list, null)} trend={data} />);
    expect(screen.getByRole('tab', { name: 'Score' })).toBeSelected();
    expect(screen.getByLabelText('Trend series')).toBeOnTheScreen();
    // The SVG renderer holds colours as ARGB numbers: the page ink, fully opaque.
    expect(screen.getByTestId('trend-line', { includeHiddenElements: true }).props.stroke).toMatchObject({ payload: (0xff000000 | parseInt(light.text.slice(1), 16)) >>> 0 });
    expect(screen.getAllByTestId('trend-dot', { includeHiddenElements: true })).toHaveLength(2);
    expect(screen.getByTestId('trend-latest', { includeHiddenElements: true })).toHaveTextContent('100');
    expect(screen.getAllByTestId('trend-tick', { includeHiddenElements: true }).map((t) => t.props.children)).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S', 'M']);
    // 100 − 10 × 50 / 30 = 83.3 on Sunday, a clean Monday.
    expect(screen.getByTestId('trend-chart-box')).toHaveAccessibleName('Score by day. Lowest 83 on Sunday, latest 100, trending up.');
  });

  test('the picker switches the series; Events read per 100 of the driver’s units, Points per drive', async () => {
    await draw(<MetricsCards sums={windowSums(list, null)} trend={data} />);
    await press(screen.getByRole('tab', { name: 'Events' }));
    expect(screen.getByRole('tab', { name: 'Events' })).toBeSelected();
    // Sunday: 3 events over 30 mi = 10 per 100 mi; Monday 0.
    expect(screen.getByTestId('trend-chart-box')).toHaveAccessibleName('Events per 100 miles by day. Lowest 0.0 today, latest 0.0, trending down.');
    expect(screen.getByTestId('trend-latest', { includeHiddenElements: true })).toHaveTextContent('0.0 /100 mi');
    await press(screen.getByRole('tab', { name: 'Points' }));
    expect(screen.getByTestId('trend-chart-box')).toHaveAccessibleName('Points per drive by day. Lowest plus 90 on Sunday, latest plus 150, trending up.');
    expect(screen.getByTestId('trend-latest', { includeHiddenElements: true })).toHaveTextContent('+150 pts');
  });

  test('in kilometres, Events read per 100 km', async () => {
    publishUnits('km');
    await draw(<MetricsCards sums={windowSums(list, null)} trend={data} />);
    await press(screen.getByRole('tab', { name: 'Events' }));
    expect(screen.getByTestId('trend-chart-box')).toHaveAccessibleName('Events per 100 kilometers by day. Lowest 0.0 today, latest 0.0, trending down.');
  });

  test('the event counts stay as numbers under the chart', async () => {
    await draw(<MetricsCards sums={windowSums(list, null)} trend={data} />);
    const row = screen.getByTestId('metrics-trend-row-0');
    expect(within(row).getAllByTestId(/^metric-(?!.*-(value|caption)$)[a-z-]+$/).map((c) => c.props.accessibilityLabel)).toEqual(['Speeding, 1', 'Hard brakes, 2', 'Hard starts, 0', 'Sharp turns, 0']);
    for (const el of within(row).getAllByTestId(/^metric-[a-z-]+-caption$/)) expect(el.props.numberOfLines).toBe(2);
  });

  test('fewer than two points: one muted line in the chart’s place, at the same height', async () => {
    const one = trend(list.slice(0, 1), [], 'week', NOW);
    await draw(<MetricsCards sums={windowSums(list, null)} trend={one} />);
    expect(screen.getByTestId('trend-empty')).toHaveTextContent('Not enough drives yet');
    expect(screen.queryByTestId('trend-chart')).toBeNull();
    const l = metricsLayout(844, 1);
    expect(flat(screen.getByTestId('trend-chart-box')).height).toBe(chartBoxHeight(l));
    // Score waits for the range's events.
    await draw(<MetricsCards sums={windowSums(list, null)} trend={trend(list, null, 'week', NOW)} />);
    expect(screen.getByTestId('trend-empty')).toBeOnTheScreen();
    await press(screen.getByRole('tab', { name: 'Points' }));
    expect(screen.queryByTestId('trend-empty')).toBeNull();
  });

  test('the curve passes through every point and never overshoots between them', () => {
    const pts = [
      { x: 0, y: 50 },
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 30, y: 40 },
    ];
    const d = monotonePath(pts);
    expect(d.startsWith('M0.0,50.0')).toBe(true);
    for (const p of pts.slice(1)) expect(d).toContain(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    // Flat between two equal points: both control points stay on the line.
    expect(d).toContain('C13.3,10.0 16.7,10.0 20.0,10.0');
    // Every control point's y stays within its segment's ends.
    const segs = d.split(' C').slice(1).map((s) => s.split(' ').map((q) => q.split(',').map(Number)));
    segs.forEach((seg, i) => {
      const lo = Math.min(pts[i]!.y, pts[i + 1]!.y);
      const hi = Math.max(pts[i]!.y, pts[i + 1]!.y);
      for (const [, y] of seg) expect(y! >= lo - 1e-9 && y! <= hi + 1e-9).toBe(true);
    });
    expect(monotonePath(pts.slice(0, 2))).toBe('M0.0,50.0 C3.3,36.7 6.7,23.3 10.0,10.0');
  });

  test('points sit inside the plot; ticks thin to fit, keeping the latest', () => {
    expect(plotPoint({ x: 0, value: 0 }, 300, 100, 0, 100)).toEqual({ x: PLOT_EDGE, y: 100 - PLOT_EDGE });
    expect(plotPoint({ x: 1, value: 100 }, 300, 100, 0, 100)).toEqual({ x: 300 - PLOT_EDGE, y: PLOT_EDGE });
    const ticks = Array.from({ length: 13 }, (_, i) => ({ x: i / 12, label: String(i) }));
    expect(visibleTicks(ticks, 300, 20)).toHaveLength(13);
    expect(visibleTicks(ticks, 300, 40).map((t) => t.label)).toEqual(['0', '2', '4', '6', '8', '10', '12']);
    expect(visibleTicks(ticks, 300, 60).map((t) => t.label)).toEqual(['0', '3', '6', '9', '12']);
  });

  test('values read as drawn and as spoken', () => {
    expect(trendValue('score', 88, 'mi')).toEqual({ value: '88', unit: '', spoken: '88' });
    expect(trendValue('events', 2.14, 'km')).toEqual({ value: '2.1', unit: '/100 km', spoken: '2.1' });
    expect(trendValue('events', 12.6, 'mi')).toMatchObject({ value: '13' });
    expect(trendValue('points', -40, 'mi')).toEqual({ value: '−40', unit: 'pts', spoken: 'minus 40' });
    expect(trendLabel('score', [], 'day', 'mi')).toBe('Not enough drives yet');
    expect(
      trendLabel(
        'score',
        [
          { x: 0, value: 90, when: 'in March' },
          { x: 1, value: 60, when: 'in April' },
        ],
        'month',
        'mi'
      )
    ).toBe('Score by month. Lowest 60 in April, latest 60, trending down.');
  });
});

describe('WhenYouDriveCard', () => {
  // NOW is Monday 15:00: these start Monday 14:00 (12p band) twice and Sunday 23:00 (9p band) once.
  const list = [
    drive({ clientTripId: 'a', startedAt: NOW - HOUR }),
    drive({ clientTripId: 'b', startedAt: NOW - HOUR - 60_000 }),
    drive({ clientTripId: 'c', startedAt: NOW - 16 * HOUR }),
  ];

  test('weekday rows by 3-hour columns, shaded by count in the page ink, with the busiest slot', async () => {
    const grid = driveGrid(list, null);
    await draw(<WhenYouDriveCard grid={grid} />);
    expect(screen.getByText('When you drive')).toBeOnTheScreen();
    for (const tick of ['12a', '6a', '12p', '6p']) expect(screen.getByText(tick)).toBeOnTheScreen();
    expect(screen.queryByText('3a')).toBeNull();
    expect(screen.getAllByText('S')).toHaveLength(2);
    expect(screen.getByTestId('grid-0-4')).toHaveStyle({ backgroundColor: light.text });
    expect(screen.getByTestId('grid-0-0')).toHaveStyle({ backgroundColor: 'transparent', borderWidth: 1, borderColor: light.border });
    expect(screen.getByTestId('analytics-grid-busiest')).toHaveTextContent('Busiest: Mon 12p–3p');
    expect(screen.getByLabelText('When you drive. 3 drives. Busiest: Monday 12p–3p, 2 drives.')).toBeOnTheScreen();
  });

  test('at large text the ticks span two columns each and never truncate, and the weekday column widens', async () => {
    setWindow(320, 568, 2);
    await draw(<WhenYouDriveCard grid={driveGrid(list, null)} />);
    for (const tick of ['12a', '6a', '12p', '6p']) {
      const el = screen.getByTestId(`grid-tick-${tick}`);
      expect(el.props.numberOfLines).toBeUndefined();
      expect(flat(el).flex).toBe(2);
    }
    expect(Number(flat(screen.getByTestId('grid-day-0')).width)).toBeGreaterThanOrEqual(tokens.type.caption.fontSize * 2);
  });

  test('a one-drive cell stands at 3:1 against the card in both schemes', () => {
    for (const c of [tokens.color.light, tokens.color.dark]) {
      expect(contrastRatio(mix(c.surface, c.text, cellAlpha(1, 10)), c.surface)).toBeGreaterThanOrEqual(3);
    }
  });

  test('no drives in the range: a short line, no grid', async () => {
    await draw(<WhenYouDriveCard grid={driveGrid([], null)} />);
    expect(screen.getByTestId('analytics-grid-empty')).toHaveTextContent('No drives yet');
    expect(screen.queryByTestId('grid-0-0')).toBeNull();
  });

  test('helpers', () => {
    expect(bandSpan(7)).toBe('9p–12a');
    expect(cellAlpha(0, 3)).toBe(0);
    expect(cellAlpha(3, 3)).toBe(1);
    expect(cellAlpha(1, 3)).toBeGreaterThan(0.45);
    expect(busiest(driveGrid([], null))).toBeNull();
  });
});

describe('TripsMapCard', () => {
  const lines: MapPoint[][] = [
    [
      { latitude: 40.7, longitude: -74 },
      { latitude: 40.71, longitude: -74.01 },
    ],
    [
      { latitude: 40.72, longitude: -74.02 },
      { latitude: 40.73, longitude: -74.03 },
    ],
  ];

  function fakeMaps(seen: { region?: unknown; scroll?: unknown; zoom?: unknown }): MapsModule {
    const MapView = ({ children, initialRegion, scrollEnabled, zoomEnabled }: { children?: ReactNode; initialRegion?: unknown; scrollEnabled?: boolean; zoomEnabled?: boolean }) => {
      Object.assign(seen, { region: initialRegion, scroll: scrollEnabled, zoom: zoomEnabled });
      return <View testID="map-view">{children}</View>;
    };
    const Polyline = () => <View testID="polyline" />;
    return { default: MapView as unknown as ComponentType, Polyline } as unknown as MapsModule;
  }

  test('every trip on a pan-and-zoom map opened on the fitted region', async () => {
    const seen: { region?: unknown; scroll?: unknown; zoom?: unknown } = {};
    setMapsForTests(fakeMaps(seen));
    const region = fitLines(lines);
    await draw(<TripsMapCard routes={lines} region={region} />);
    expect(screen.getByText('All trips')).toBeOnTheScreen();
    expect(screen.getByTestId('trips-map', { includeHiddenElements: true })).toHaveStyle({ height: 320 });
    expect(screen.getAllByTestId('polyline', { includeHiddenElements: true })).toHaveLength(2);
    expect(seen).toEqual({ region, scroll: true, zoom: true });
  });

  test('no maps module: one plain line instead', async () => {
    setMapsForTests(null);
    await draw(<TripsMapCard routes={lines} region={fitLines(lines)} />);
    expect(screen.getByTestId('trips-map-nomap')).toHaveTextContent("Maps aren't available in this build.");
    expect(screen.queryByTestId('trips-map', { includeHiddenElements: true })).toBeNull();
  });

  test('no trips yet', async () => {
    setMapsForTests(fakeMaps({}));
    await draw(<TripsMapCard routes={[]} region={null} />);
    expect(screen.getByTestId('trips-map-empty')).toHaveTextContent('No trips yet');
  });
});

describe('DrivesCard', () => {
  test('closed at first; opens to the range’s drives titled by date and time', async () => {
    const onOpen = jest.fn();
    await draw(<DrivesCard drives={drives(3)} rangeKey="week" onOpen={onOpen} />);
    const toggle = screen.getByTestId('analytics-drives-toggle');
    expect(toggle).toHaveAccessibleName('Drives, 3');
    expect(screen.getByText('Drives · 3')).toBeOnTheScreen();
    expect(toggle.props.accessibilityState).toMatchObject({ expanded: false });
    expect(screen.queryByTestId('analytics-drives-list')).toBeNull();
    await press(toggle);
    expect(screen.getByTestId('analytics-drives-toggle').props.accessibilityState).toMatchObject({ expanded: true });
    expect(screen.getByText('Mon, Oct 5 · 2:00 PM')).toBeOnTheScreen();
    expect(screen.getAllByText('12.0 mi · 24 min · +132 pts · 1 event')).toHaveLength(3);
    // Rows wrap rather than cut the points and events off at large text.
    for (const id of ['analytics-drive-when', 'analytics-drive-line']) {
      for (const el of screen.getAllByTestId(id)) expect(el.props.numberOfLines).toBeUndefined();
    }
    await press(screen.getByTestId('analytics-drive-d1'));
    expect(onOpen).toHaveBeenCalledWith('d1');
  });

  test('ten rows, then Show more adds ten at a time; a new range starts over', async () => {
    const list = drives(25, 5);
    const { rerender } = await draw(<DrivesCard drives={list} rangeKey="week" onOpen={jest.fn()} />);
    await press(screen.getByTestId('analytics-drives-toggle'));
    expect(screen.getAllByTestId(/^analytics-drive-d/)).toHaveLength(DRIVES_PAGE);
    await press(screen.getByTestId('analytics-drives-more'));
    expect(screen.getAllByTestId(/^analytics-drive-d/)).toHaveLength(20);
    await press(screen.getByTestId('analytics-drives-more'));
    expect(screen.getAllByTestId(/^analytics-drive-d/)).toHaveLength(25);
    expect(screen.queryByTestId('analytics-drives-more')).toBeNull();
    await rerender(
      <ThemeProvider scheme="light" reduceMotion>
        <DrivesCard drives={list} rangeKey="month" onOpen={jest.fn()} />
      </ThemeProvider>
    );
    expect(screen.getAllByTestId(/^analytics-drive-d/)).toHaveLength(DRIVES_PAGE);
  });

  test('a row reads as one button with the whole line in words', async () => {
    await draw(<DrivesCard drives={drives(1)} rangeKey="week" onOpen={jest.fn()} />);
    await press(screen.getByTestId('analytics-drives-toggle'));
    expect(screen.getByTestId('analytics-drive-d0')).toHaveAccessibleName('Mon, Oct 5 · 2:00 PM, 12.0 miles, 24 minutes, plus 132 points, 1 event');
  });

  test('clean, eventless and estimated lines', () => {
    const none = { ...drive().counts, hardBrake: 0 };
    expect(driveLine(drive({ clean: true, counts: none }), 'mi').text).toBe('12.0 mi · 24 min · +132 pts · Clean');
    expect(driveLine(drive({ clean: false, counts: none }), 'mi').text).toBe('12.0 mi · 24 min · +132 pts · No events');
    expect(driveLine(drive({ estimate: true }), 'km').text).toBe('19.3 km · 24 min · +132 pts est. · 1 event');
  });

  test('no drives in the range: the header says so and does not open', async () => {
    await draw(<DrivesCard drives={[]} rangeKey="day" onOpen={jest.fn()} />);
    const header = screen.getByTestId('analytics-drives-toggle');
    expect(header).toHaveAccessibleName('Drives, none yet');
    expect(header.props.accessibilityRole).toBe('header');
    expect(header.props.accessibilityState?.disabled).not.toBe(true);
    expect(screen.getByText('Drives · 0')).toBeOnTheScreen();
    expect(screen.getByTestId('analytics-drives-empty')).toHaveTextContent('No drives yet');
    await press(screen.getByTestId('analytics-drives-toggle'));
    expect(screen.queryByTestId('analytics-drives-list')).toBeNull();
  });
});

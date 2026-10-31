import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { ComponentType, ReactNode } from 'react';
import { StyleSheet, View, type TextStyle, type ViewStyle } from 'react-native';

import { publishUnits, resetUnitsForTests } from '@/data/queries/units';
import { ratingAt } from '@scoring';

import { draw, drive, HOUR, NOW, press } from '@/features/drives/__fixtures__/drives';
import { setMapsForTests, type MapsModule } from '@/features/settings/maps';
import { contrastRatio } from '@/ui';
import { ThemeProvider } from '@/ui/theme';
import { tokens } from '@/ui/tokens';

import { drives, NO_SCORES, SCORES } from '../__fixtures__/analytics';
import { AllTimeCard } from '../AllTimeCard';
import { categoryGroup, CategorySheet, categoryTitle, rateLine } from '../CategorySheet';
import { analyticsCopy } from '../copy';
import { DRIVES_PAGE, DrivesCard, driveLine } from '../DrivesCard';
import {
  drivingGroup,
  MAIN_BLOCK,
  mainLayout,
  metricsBlockHeight,
  MetricsCards,
  metricsLayout,
  METRICS_MAX_SHARE,
  metricsText,
  NO_CHART_BLOCK,
  RANGE_GROUP_BORDER,
  RANGE_GROUP_PAD,
  rangeGroupChrome,
} from '../MetricsCards';
import {
  allTimeTotals,
  AXES,
  coach,
  driveGrid,
  EMPTY_TREND,
  EMPTY_WINDOW,
  fitLines,
  toRatingDrives,
  trend,
  windowSums,
  type MapPoint,
  type Range,
  type Trend,
  type WindowSums,
} from '../model';
import { axisAt, RADAR_LABEL_MAX_SCALE, RADAR_RINGS, RADAR_ZERO, radarGeometry, radarLabel, radarPoint, radarPolygon, RadarCard, radiusFor, zeroRadius } from '../RadarCard';
import { SummaryCard } from '../SummaryCard';
import {
  AXIS_GAP,
  axisTicks,
  axisValue,
  axisWidth,
  chartBoxHeight,
  eventsPer,
  monotonePath,
  pickerHeight,
  PLOT_EDGE,
  plotPoint,
  trendLabel,
  trendValue,
  visibleTicks,
} from '../TrendCard';
import { TripsMapCard } from '../TripsMapCard';
import { bandSpan, busiest, cellLevel, HEAT_RAMP, WhenYouDriveCard } from '../WhenYouDriveCard';

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
  /** The drawn shape's vertices, read off its path ("M x y x y … z"). */
  const shapePoints = (): number => {
    const d = String(screen.getByTestId('radar-shape', { includeHiddenElements: true }).props.d);
    return d.replace(/^M|z$/gi, '').trim().split(/[\s,]+/).length / 2;
  };

  test('the Safety Rating sits in the middle as a whole number, with every category named around it', async () => {
    await draw(<RadarCard dashpalPaired rating={92.4} scores={SCORES} onOpen={jest.fn()} />);
    expect(screen.getByTestId('radar-rating')).toHaveTextContent('92');
    expect(screen.getByTestId('radar-out-of')).toHaveTextContent('/100');
    // the name is in the footer, not the middle
    expect(screen.queryByText('Safety Rating', { includeHiddenElements: true })).toBeNull();
    // a card-coloured halo keeps the shape's lines out of the centre number
    expect(screen.getByTestId('radar-rating')).toHaveStyle({ textShadowColor: light.surface });
    expect(screen.getAllByTestId(/^radar-dot-/, { includeHiddenElements: true })).toHaveLength(6);
    for (const label of ['Acceleration', 'Braking', 'Turning', 'Attention', 'Phone use', 'Speed']) expect(screen.getByText(label)).toBeOnTheScreen();
    expect(screen.getByText('Safety Rating · Last 90 days')).toBeOnTheScreen();
  });

  test('a "How it works" button under the chart opens a sheet saying what makes the total', async () => {
    await draw(<RadarCard dashpalPaired rating={92.4} scores={SCORES} onOpen={jest.fn()} />);
    const how = screen.getByRole('button', { name: 'How it works' });
    expect(how.props.accessibilityHint).toBe('Explains the Safety Rating');
    // At least the touch floor, at the right of the card's last row, beside "Safety Rating · Last 90 days".
    expect(Number(flat(how).minHeight)).toBeGreaterThanOrEqual(tokens.size.touch);
    expect(Number(flat(how).minWidth)).toBeGreaterThanOrEqual(tokens.size.touch);
    const footer = screen.getByTestId('radar-footer');
    expect(flat(footer).flexDirection).toBe('row');
    expect(within(footer).getByText('Safety Rating · Last 90 days')).toBeOnTheScreen();
    expect(screen.queryByTestId('radar-how-sheet')).toBeNull();
    await press(how);
    expect(screen.getByRole('header', { name: 'How it works' })).toBeOnTheScreen();
    const body = screen.getByTestId('radar-how-body');
    expect(body).toHaveTextContent(
      "Your Safety Rating is the average of your category scores, with Speed and Phone use counting double. Each one covers your last 90 days, with recent weeks counting a bit more, and compares your slips to your chances to slip: hard brakes per slowdown, hard starts per speed-up, sharp turns per turn, how much of your driving is over the limit, and how often you pick up your phone at driving speed and how long you hold it while you're moving. You start at a typical driver's score and move from there with every drive."
    );
    // No em dash, no points.
    expect(String(body.props.children)).not.toMatch(/—|points?\b/i);
    await press(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    await waitFor(() => expect(screen.queryByTestId('radar-how-sheet')).toBeNull());
  });

  test('each chip holds its name and nothing else, scored or not', async () => {
    for (const scores of [SCORES, NO_SCORES]) {
      await draw(<RadarCard dashpalPaired rating={null} scores={scores} onOpen={jest.fn()} />);
      for (const a of AXES) {
        const chip = screen.getByTestId(`radar-chip-${a.key}`);
        expect(chip).toHaveTextContent(a.label, { exact: true });
        // a pill: rounded ends, the name centred on one line
        expect(Number(flat(chip).borderRadius)).toBeCloseTo(Number(flat(chip).height) / 2);
        expect(within(chip).getByText(a.label)).toHaveProp('numberOfLines', 1);
      }
    }
  });

  test('one summary label for a screen reader lists the rating and every axis', async () => {
    await draw(<RadarCard dashpalPaired rating={92.4} scores={SCORES} onOpen={jest.fn()} />);
    const label = 'Safety Rating 92 out of 100. Acceleration 95, Braking 72, Turning 100, Attention 90, Phone use 84, Speed 88.';
    expect(screen.getByLabelText(label)).toBeOnTheScreen();
    expect(screen.getByLabelText(label).props.accessibilityRole).toBe('image');
  });

  test('each chip is a button that opens its category, named with its score, with or without data', async () => {
    const onOpen = jest.fn();
    await draw(<RadarCard dashpalPaired rating={92.4} scores={{ ...SCORES, turning: null }} onOpen={onOpen} />);
    const speed = screen.getByRole('button', { name: 'Speed, score 88' });
    expect(speed.props.accessibilityHint).toBe('Opens details');
    expect(screen.getByRole('button', { name: 'Turning, no score yet' })).toBeOnTheScreen();
    // The six chips and "How it works".
    expect(screen.getAllByRole('button')).toHaveLength(7);
    for (const a of AXES) {
      expect(Number(flat(screen.getByTestId(`radar-axis-${a.key}`)).height)).toBeGreaterThanOrEqual(tokens.size.touch);
      await press(screen.getByTestId(`radar-axis-${a.key}`));
      expect(onOpen).toHaveBeenLastCalledWith(a.key);
    }
    onOpen.mockClear();
    await draw(<RadarCard dashpalPaired rating={null} scores={NO_SCORES} onOpen={onOpen} />);
    await press(screen.getByTestId('radar-axis-attention'));
    expect(onOpen).toHaveBeenLastCalledWith('attention');
  });

  test('without a DashPal, Attention is locked: a greyed chip with a lock, a greyed dot on the zero ring, and it still opens', async () => {
    const onOpen = jest.fn();
    await draw(<RadarCard dashpalPaired={false} rating={80} scores={SCORES} onOpen={onOpen} />);
    expect(screen.getByTestId('radar-lock-attention')).toBeOnTheScreen();
    expect(screen.queryByTestId('radar-lock-speed')).toBeNull();
    expect(screen.getByTestId('radar-dot-attention', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.getAllByTestId(/^radar-dot-/, { includeHiddenElements: true })).toHaveLength(6);
    expect(shapePoints()).toBe(6);
    expect(
      screen.getByLabelText('Safety Rating 80 out of 100. Acceleration 95, Braking 72, Turning 100, Attention needs DashPal, Phone use 84, Speed 88.')
    ).toBeOnTheScreen();
    await press(screen.getByRole('button', { name: 'Attention, needs DashPal' }));
    expect(onOpen).toHaveBeenLastCalledWith('attention');
    // the shape joins the locked axis's neighbours across it
    expect(radarPolygon([100, 100, 100, 100, 100], 100, { x: 150, y: 150 }, [3]).split(' ')).toHaveLength(4);
  });

  test('Phone use with no score yet keeps its vertex on the shape, greyed out, and it still opens', async () => {
    const onOpen = jest.fn();
    await draw(<RadarCard dashpalPaired rating={80} scores={{ ...SCORES, phone: null }} onOpen={onOpen} />);
    expect(screen.getByTestId('radar-dot-phone', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.getAllByTestId(/^radar-dot-/, { includeHiddenElements: true })).toHaveLength(6);
    expect(shapePoints()).toBe(6);
    expect(screen.getByLabelText(/Phone use no data, Speed 88\.$/)).toBeOnTheScreen();
    await press(screen.getByRole('button', { name: 'Phone use, no score yet' }));
    expect(onOpen).toHaveBeenLastCalledWith('phone');
    // With a score, it is a point like any other.
    await draw(<RadarCard dashpalPaired rating={80} scores={SCORES} onOpen={onOpen} />);
    expect(shapePoints()).toBe(6);
  });

  test('a tap on the chart opens the category whose spoke it is nearest; the middle and far outside open nothing', () => {
    const c = { x: 150, y: 150 };
    const r = 100;
    const keyAt = (x: number, y: number) => {
      const i = axisAt(x, y, r, c);
      return i === null ? null : AXES[i]!.key;
    };
    expect(keyAt(150, 60)).toBe('acceleration'); // straight up
    const p = radarPoint(1, 6, 70, c);
    expect(keyAt(p.x, p.y)).toBe('braking');
    const t = radarPoint(2, 6, 80, c);
    expect(keyAt(t.x, t.y)).toBe('turning');
    const a = radarPoint(3, 6, 80, c);
    expect(keyAt(a.x, a.y)).toBe('attention'); // straight down
    const ph = radarPoint(4, 6, 80, c);
    expect(keyAt(ph.x, ph.y)).toBe('phone');
    const q = radarPoint(5, 6, 90, c);
    expect(keyAt(q.x + 4, q.y - 3)).toBe('speed');
    expect(keyAt(150, 150)).toBeNull();
    expect(keyAt(156, 156)).toBeNull();
    // Inside the zero ring is the rating's; just outside it is the spoke's.
    expect(keyAt(150, 150 - zeroRadius(100) + 1)).toBeNull();
    expect(keyAt(150, 150 - zeroRadius(100) - 1)).toBe('acceleration');
    expect(keyAt(150, 20)).toBeNull();
  });

  test('a tap on the chart reaches onOpen through its measured position', async () => {
    const onOpen = jest.fn();
    await draw(<RadarCard dashpalPaired rating={80} scores={SCORES} onOpen={onOpen} />);
    const g = radarGeometry(390 - 4 * tokens.space.lg, 1);
    const top = radarPoint(0, 6, g.r * 0.8, g.c);
    fireEvent.press(screen.getByTestId('radar-chart'), { nativeEvent: { pageX: top.x, pageY: top.y, locationX: top.x, locationY: top.y } });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('acceleration'));
  });

  test('no rating and no data: a dash in the middle, and the shape lies on the zero ring, never a point', async () => {
    await draw(<RadarCard dashpalPaired rating={null} scores={NO_SCORES} onOpen={jest.fn()} />);
    expect(screen.getByTestId('radar-rating')).toHaveTextContent('—');
    expect(screen.queryByTestId('radar-out-of')).toBeNull();
    expect(screen.getAllByText('—')).toHaveLength(1);
    // every axis keeps a (greyed-out) dot on the zero ring: a perfect small hexagon
    expect(screen.getAllByTestId(/^radar-dot-/, { includeHiddenElements: true })).toHaveLength(6);
    expect(shapePoints()).toBe(6);
    expect(radarLabel(null, NO_SCORES)).toBe(
      'Safety Rating, no score yet. Acceleration no data, Braking no data, Turning no data, Attention no data, Phone use no data, Speed no data.'
    );
    const c = { x: 150, y: 150 };
    const zero = Array.from({ length: 5 }, (_, i) => radarPoint(i, 5, zeroRadius(100), c))
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ');
    expect(radarPolygon([null, null, null, null, null], 100, c)).toBe(zero);
    expect(radarPolygon([0, 0, 0, 0, 0], 100, c)).toBe(zero);
    expect(new Set(zero.split(' ')).size).toBe(5);
  });

  test('the zero ring: 0 sits at 10 % of the radius (at least 13⅓ pt), 100 on the outer ring, rings drawn at 0/25/50/75/100', async () => {
    expect(RADAR_ZERO).toBe(0.1);
    expect(RADAR_RINGS).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(radiusFor(0, 100)).toBeCloseTo(40 / 3);
    expect(radiusFor(null, 100)).toBeCloseTo(40 / 3);
    expect(radiusFor(50, 100)).toBeCloseTo(50 + 40 / 6);
    expect(radiusFor(100, 100)).toBeCloseTo(100);
    expect(radiusFor(140, 100)).toBeCloseTo(100);
    expect(radiusFor(-5, 100)).toBeCloseTo(40 / 3);
    await draw(<RadarCard dashpalPaired rating={80} scores={{ ...SCORES, braking: 0 }} onOpen={jest.fn()} />);
    for (const k of [0, 25, 50, 75, 100]) expect(screen.getByTestId(`radar-ring-${k}`, { includeHiddenElements: true })).toBeOnTheScreen();
    // A 0 still has its dot, on the zero ring.
    const g = radarGeometry(390 - 4 * tokens.space.lg, 1);
    const dot = screen.getByTestId('radar-dot-braking', { includeHiddenElements: true });
    expect(Math.hypot(Number(dot.props.cx) - g.c.x, Number(dot.props.cy) - g.c.y)).toBeCloseTo(zeroRadius(g.r), 1);
  });

  test('geometry: the first axis points straight up, the pentagon runs clockwise', () => {
    const c = { x: 100, y: 100 };
    expect(radarPoint(0, 5, 50, c)).toEqual({ x: 100, y: 50 });
    const p1 = radarPoint(1, 5, 50, c);
    expect(p1.x).toBeCloseTo(100 + 50 * Math.cos(Math.PI / 10));
    expect(p1.y).toBeCloseTo(100 - 50 * Math.sin(Math.PI / 10));
    // the two lower vertices sit 0.809 r below the centre, 0.588 r out
    expect(radarPoint(2, 5, 50, c).y).toBeCloseTo(100 + 50 * Math.cos(Math.PI / 5), 5);
    expect(radarPoint(3, 5, 50, c).x).toBeCloseTo(100 - 50 * Math.sin(Math.PI / 5), 5);
    expect(radarPolygon([100, 50, 0, 0, 0], 100, c).split(' ')[0]).toBe('100.0,0.0');
    expect(radarPolygon([140, 50, 0, 0, 0], 100, c).split(' ')[0]).toBe('100.0,0.0');
    // a score of 0 sits on the zero ring, straight up 13⅓ from the centre (the zero ring's floor)
    expect(radarPolygon([0, 50, 0, 0, 0], 100, c).split(' ')[0]).toBe('100.0,86.7');
    expect(radarPolygon([50, 50, 0, 0, 0], 100, c).split(' ')[0]).toBe('100.0,43.3');
  });

  const overlaps = (a: { left: number; top: number; width: number; height: number }, b: typeof a) =>
    a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

  /** Whether (x, y) is inside the convex polygon `pts` (clockwise on screen). */
  const inside = (pts: readonly { x: number; y: number }[], x: number, y: number) =>
    pts.every((p, i) => {
      const q = pts[(i + 1) % pts.length]!;
      return (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x) > 0;
    });

  test.each([
    [326, 1],
    [288, 1],
    [256, 1],
    [326, RADAR_LABEL_MAX_SCALE],
    [288, RADAR_LABEL_MAX_SCALE],
    [256, RADAR_LABEL_MAX_SCALE],
  ])('six labels sit wholly outside the hexagon and inside the chart (width %d, text %d×)', (width, scale) => {
    const g = radarGeometry(width, scale);
    expect(g.labels).toHaveLength(6);
    const pts = Array.from({ length: 6 }, (_, i) => radarPoint(i, 6, g.r, g.c));
    const [top, upRight, downRight, bottom, downLeft, upLeft] = g.labels;
    for (const b of [top!, bottom!]) expect(b.align).toBe('center');
    for (const b of [upRight!, downRight!]) expect(b.align).toBe('left');
    for (const b of [downLeft!, upLeft!]) expect(b.align).toBe('right');
    // The chips (centred in their touch boxes) clear the hexagon: no point of a chip's edge is inside it.
    for (const b of g.labels) {
      const pad = (b.height - g.chip) / 2;
      const y0 = b.top + pad;
      const y1 = y0 + g.chip;
      for (let k = 0; k <= 20; k++) {
        const x = b.left + (b.width * k) / 20;
        const y = y0 + (g.chip * k) / 20;
        for (const [px, py] of [
          [x, y0],
          [x, y1],
          [b.left, y],
          [b.left + b.width, y],
        ] as const)
          expect(inside(pts, px, py)).toBe(false);
      }
    }
    for (const b of g.labels) {
      // each label is a button: never under the touch floor
      expect(b.height).toBeGreaterThanOrEqual(tokens.size.touch);
      expect(b.width).toBeGreaterThanOrEqual(tokens.size.touch);
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.top).toBeGreaterThanOrEqual(0);
      expect(b.left + b.width).toBeLessThanOrEqual(g.width);
      expect(b.top + b.height).toBeLessThanOrEqual(g.height + 1);
    }
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) expect(overlaps(g.labels[i]!, g.labels[j]!)).toBe(false);
    // An even count is symmetric: the centre sits in the middle, the top and bottom labels as far from it.
    expect(g.c.y).toBeCloseTo(g.height / 2, 0);
    expect(g.c.y - top!.top).toBeCloseTo(bottom!.top + bottom!.height - g.c.y, 5);
  });

  test('at 320 pt wide with 1.3× labels the hexagon still fits its card', () => {
    // The card's inside on a 320 pt phone: the gutter and the card padding on both sides.
    const g = radarGeometry(320 - 4 * tokens.space.lg, RADAR_LABEL_MAX_SCALE);
    for (const b of g.labels) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.left + b.width).toBeLessThanOrEqual(g.width);
    }
  });

  test('the drawn labels follow the geometry and stop growing at 1.3× text', async () => {
    setWindow(390, 844, 2);
    await draw(<RadarCard dashpalPaired rating={80} scores={SCORES} onOpen={jest.fn()} />);
    const g = radarGeometry(390 - 4 * tokens.space.lg, RADAR_LABEL_MAX_SCALE);
    const box = g.labels[1]!;
    expect(flat(screen.getByTestId('radar-axis-braking'))).toMatchObject({ left: box.left, top: box.top, width: box.width, height: box.height });
    expect(flat(screen.getByTestId('radar-chip-braking'))).toMatchObject({ height: g.chip, maxWidth: box.width });
    expect(flat(screen.getByText('Braking')).fontSize).toBeCloseTo(tokens.type.caption.fontSize * RADAR_LABEL_MAX_SCALE);
  });

  test('the chart ink is monotone: the page ink, no signal colours', async () => {
    await draw(<RadarCard dashpalPaired rating={80} scores={SCORES} onOpen={jest.fn()} />);
    expect(screen.getByTestId('radar-rating')).toHaveStyle({ color: light.text });
    expect(screen.getByText('Speed')).toHaveStyle({ color: light.text });
  });
});

describe('SummaryCard', () => {
  test('a weak axis: its level icon in its colour, the title and the tip, with the level word spoken', async () => {
    await draw(<SummaryCard coaching={coach(SCORES, { drives: 4, miles: 48 })} />);
    expect(screen.getByText('Brake more gently')).toBeOnTheScreen();
    expect(screen.getByText('Leave more room so you can brake gently.')).toBeOnTheScreen();
    expect(screen.getByTestId('analytics-summary-icon')).toHaveStyle({ color: light.warning });
    expect(screen.getByLabelText('Fair. Brake more gently. Leave more room so you can brake gently.')).toBeOnTheScreen();
  });

  test('the other weak areas sit under the tip as small level icons with their names, weakest first', async () => {
    const c = coach({ ...SCORES, braking: 72, speed: 55, acceleration: 40 }, { drives: 4, miles: 48 });
    await draw(<SummaryCard coaching={c} />);
    const row = screen.getByTestId('analytics-summary-also');
    expect(StyleSheet.flatten(row.props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
    expect(within(row).getByText('Speed')).toBeOnTheScreen();
    expect(within(row).getByText('Braking')).not.toHaveProp('numberOfLines');
    expect(screen.getByTestId('analytics-summary-also-speed-icon')).toHaveStyle({ color: light.danger, fontSize: tokens.size.iconSm });
    expect(screen.getByTestId('analytics-summary-also-braking-icon')).toHaveStyle({ color: light.warning, fontSize: tokens.size.iconSm });
    expect(screen.getByLabelText(/Also watch: Speed, poor\. Braking, fair\.$/)).toBeOnTheScreen();
  });

  test('no row when nothing else needs watching', async () => {
    await draw(<SummaryCard coaching={coach(SCORES, { drives: 4, miles: 48 })} />);
    expect(screen.queryByTestId('analytics-summary-also')).toBeNull();
  });

  test('good driving gets a compliment and a green check', async () => {
    const good = { speed: 95, braking: 90, acceleration: 99, turning: 100, attention: 90, phone: 92 };
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

describe('AllTimeCard', () => {
  const list = [
    drive({ clientTripId: 'short', miles: 9, clean: true, counts: { ...drive().counts, hardBrake: 0 } }),
    drive({ clientTripId: 'long', miles: 31.24, clean: true, counts: { ...drive().counts, hardBrake: 0 } }),
    drive({ clientTripId: 'rough', miles: 50, clean: false }),
  ];

  test('titled All time: the longest clean drive, which opens its drive, and the clean drives; no points', async () => {
    const onOpen = jest.fn();
    await draw(<AllTimeCard allTime={allTimeTotals(list)} onOpen={onOpen} />);
    expect(screen.getByRole('header', { name: 'All time' })).toBeOnTheScreen();
    expect(screen.queryByText('Personal best')).toBeNull();
    expect(screen.getByTestId('all-time-longest-clean-value')).toHaveTextContent('31.2 mi');
    expect(screen.getByLabelText('Longest clean, 31.2 miles')).toBeOnTheScreen();
    // Two of the three drives had no events.
    expect(screen.getByTestId('all-time-clean-drives-value')).toHaveTextContent('2');
    expect(screen.getByLabelText('Clean drives, 2')).toBeOnTheScreen();
    expect(screen.getByTestId('all-time-clean-drives').props.accessibilityRole).toBeUndefined();
    expect(screen.queryByText(/points?|pts/i)).toBeNull();
    await press(screen.getByTestId('all-time-longest-clean'));
    expect(onOpen).toHaveBeenCalledWith('long');
  });

  test('in kilometres when the driver uses them', async () => {
    publishUnits('km');
    await draw(<AllTimeCard allTime={allTimeTotals(list)} onOpen={jest.fn()} />);
    expect(screen.getByTestId('all-time-longest-clean-value')).toHaveTextContent('50.3 km');
  });

  test('the longest clean drive archived (past 183 days): its distance still shows, with nothing to press', async () => {
    const onOpen = jest.fn();
    const archived = [...list.slice(0, 1), { ...list[1]!, archived: true }, list[2]!];
    await draw(<AllTimeCard allTime={allTimeTotals(archived)} onOpen={onOpen} />);
    expect(screen.getByTestId('all-time-longest-clean-value')).toHaveTextContent('31.2 mi');
    expect(screen.getByTestId('all-time-clean-drives-value')).toHaveTextContent('2');
    expect(screen.getByTestId('all-time-longest-clean').props.accessibilityRole).toBeUndefined();
    await press(screen.getByTestId('all-time-longest-clean'));
    expect(onOpen).not.toHaveBeenCalled();
  });

  test('no drives yet: a dash for the longest, nothing to press, and no clean drives', async () => {
    await draw(<AllTimeCard allTime={allTimeTotals([])} onOpen={jest.fn()} />);
    expect(screen.getAllByText('—')).toHaveLength(1);
    expect(screen.getByTestId('all-time-longest-clean').props.accessibilityRole).toBeUndefined();
    expect(screen.getByLabelText('Longest clean, none yet')).toBeOnTheScreen();
    expect(screen.getByTestId('all-time-clean-drives-value')).toHaveTextContent('0');
  });
});

describe('MetricsCards', () => {
  const group = (ui: { sums: WindowSums; trend: Trend; range?: Range; onRange?: (r: Range) => void }) => (
    <MetricsCards sums={ui.sums} trend={ui.trend} range={ui.range ?? 'week'} onRange={ui.onRange ?? jest.fn()} />
  );
  /** The group's direct children by testID, top to bottom. */
  const groupChildren = () =>
    (screen.getByTestId('analytics-metrics').children as El[]).flatMap(function ids(n: El | string): string[] {
      if (typeof n === 'string') return [];
      const id = n.props.testID as unknown;
      return typeof id === 'string' ? [id] : n.children.flatMap((c) => ids(c as El | string));
    });

  test('one group: the range toggle at its top, then Driving with the drive time and Trends with the range’s clean share; no Clean driving card, no points', async () => {
    const sums = windowSums(drives(4), null);
    const onRange = jest.fn();
    await draw(group({ sums, trend: EMPTY_TREND, onRange }));
    expect(groupChildren()).toEqual(['analytics-range', 'metrics-driving', 'metrics-trend']);
    expect(screen.getByLabelText('Time range, for Driving and Trends')).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Week' })).toBeSelected();
    await press(screen.getByRole('tab', { name: 'Year' }));
    expect(onRange).toHaveBeenCalledWith('year');
    for (const [key, title] of [
      ['driving', 'Driving'],
      ['trend', 'Trends'],
    ]) expect(screen.getByTestId(`metrics-${key}-title`)).toHaveTextContent(title!);
    expect(screen.queryByTestId('metrics-clean')).toBeNull();
    expect(screen.queryByText('Clean driving')).toBeNull();
    // Phone pickups and time in hand live in Phone use's sheet, not here.
    for (const key of ['clean', 'clean-rate', 'pickups', 'in-hand']) expect(screen.queryByTestId(`metric-${key}`)).toBeNull();
    expect(screen.queryByTestId('metrics-points')).toBeNull();
    expect(screen.queryByTestId('metrics-events')).toBeNull();
    expect(screen.queryByTestId('metrics-trend-row-0')).toBeNull();
    for (const key of ['speeding', 'brakes', 'starts', 'turns', 'points', 'avg-points', 'after-dark', 'dark-share']) expect(screen.queryByTestId(`metric-${key}`)).toBeNull();
    expect(screen.getByRole('tab', { name: 'Events' })).toBeOnTheScreen();
    expect(screen.queryByRole('tab', { name: 'Points' })).toBeNull();
    expect(MAIN_BLOCK).toEqual({ cards: [5], chart: true, grouped: true });
    expect(drivingGroup(sums, 'mi').cells.map((c) => c.caption)).toEqual(['Drives', 'Drive time', 'Distance', 'Avg drive', 'Avg speed']);
    // None of the four drives was clean: the range's share in the Trends card.
    expect(screen.getByTestId('metrics-trend-clean-value')).toHaveTextContent('0%');
    expect(screen.getByTestId('metrics-trend-clean')).toHaveTextContent('0% clean drives');
    expect(screen.getByLabelText('Clean drives, 0 percent')).toBeOnTheScreen();
    expect(screen.getByTestId('metric-drives-value')).toHaveTextContent('4');
    // Four 24-minute drives: 96 min.
    expect(screen.getByTestId('metric-drive-time-value')).toHaveTextContent('1.6 h');
    expect(screen.getByLabelText('Drive time, 1.6 hours')).toBeOnTheScreen();
    expect(screen.getByTestId('metric-distance-value')).toHaveTextContent('48.0 mi');
    expect(screen.getByTestId('metric-avg-drive-value')).toHaveTextContent('12.0 mi');
    expect(screen.getByTestId('metric-speed-value')).toHaveTextContent('30 mph');
    expect(screen.getByLabelText('Distance, 48.0 miles')).toBeOnTheScreen();
    expect(screen.getByLabelText('Avg drive, 12.0 miles')).toBeOnTheScreen();
    expect(screen.queryByText(/points?\b|pts/i)).toBeNull();
    expect(drivingGroup(sums, 'km').cells[3]!.metric).toMatchObject({ value: '19.3', unit: 'km' });
  });

  test('the clean share follows the range’s drives', async () => {
    const list = [...drives(3, 5, { clean: true }), ...drives(1, 5, { clientTripId: 'x' })];
    await draw(group({ sums: windowSums(list, null), trend: EMPTY_TREND }));
    expect(screen.getByTestId('metrics-trend-clean')).toHaveTextContent('75% clean drives');
    expect(screen.getByLabelText('Clean drives, 75 percent')).toBeOnTheScreen();
  });

  test('an empty range reads as zeros and dashes', async () => {
    await draw(group({ sums: EMPTY_WINDOW, trend: EMPTY_TREND }));
    expect(screen.getByTestId('metric-drives-value')).toHaveTextContent('0');
    expect(screen.getByTestId('metric-distance-value')).toHaveTextContent('0.0 mi');
    expect(screen.getByTestId('metric-avg-drive-value')).toHaveTextContent('— mi');
    expect(screen.getByTestId('metric-speed-value')).toHaveTextContent('— mph');
    expect(screen.getByTestId('metric-drive-time-value')).toHaveTextContent('0 min');
    expect(screen.getByTestId('metrics-trend-clean')).toHaveTextContent('— clean drives');
    expect(screen.getByLabelText('Clean drives, no data')).toBeOnTheScreen();
    // a zero-drive range from real data reads the same: no NaN or Infinity
    for (const c of drivingGroup(windowSums([], null), 'km', true).cells) expect(c.metric.value).not.toMatch(/NaN|Infinity/);
  });

  test.each(['light', 'dark'] as const)('the group is a hairline outline in the %s theme’s border colour, its corners concentric with the cards inside', async (scheme) => {
    await render(
      <ThemeProvider scheme={scheme} reduceMotion>
        {group({ sums: EMPTY_WINDOW, trend: EMPTY_TREND })}
      </ThemeProvider>
    );
    const style = flat(screen.getByTestId('analytics-metrics'));
    expect(style).toMatchObject({
      borderWidth: RANGE_GROUP_BORDER,
      borderColor: tokens.color[scheme].border,
      padding: RANGE_GROUP_PAD,
      borderRadius: tokens.radius.card + RANGE_GROUP_BORDER + RANGE_GROUP_PAD,
    });
    expect(RANGE_GROUP_BORDER).toBe(1);
    // No fill of its own: the page shows through between the paper cards.
    expect(style.backgroundColor).toBeUndefined();
    expect(flat(screen.getByTestId('metrics-driving')).backgroundColor).toBe(tokens.color[scheme].surface);
  });

  /**
   * The block's height as drawn, read off the rendered tree: each card's padding, its title's line,
   * and per row the card gap plus the tallest cell (number line + cell gap + caption line); then the
   * gaps between the cards. The trend card counts its header row (the title or the picker, the
   * taller), its clean line and its chart box. Around them the group's outline and padding, and the
   * range toggle with a gap under it. The lines are the rendered `lineHeight`s and heights, so this
   * follows whatever sizes and spacing the cards actually use.
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
  /** One number card's drawn height. */
  function numberCardDrawn(key: string): number {
    const card = flat(screen.getByTestId(`metrics-${key}`));
    const gap = Number(card.gap ?? 0);
    const title = Number(flat(screen.getByTestId(`metrics-${key}-title`)).lineHeight);
    const rows = screen.getAllByTestId(new RegExp(`^metrics-${key}-row-`));
    const rowsH = rows.reduce((sum, row) => sum + gap + rowHeight(row), 0);
    return Number(card.padding ?? 0) * 2 + title + rowsH;
  }
  function drawnHeight(): number {
    const cards = (['driving', 'trend'] as const).flatMap((key) => {
      if (key !== 'trend') return [numberCardDrawn(key)];
      const trendCard = screen.queryByTestId('metrics-trend');
      if (!trendCard) return [];
      const card = flat(trendCard);
      const gap = Number(card.gap ?? 0);
      const header = Math.max(
        Number(flat(screen.getByTestId('metrics-trend-title')).lineHeight),
        Number(flat(screen.getByTestId('metrics-trend-picker')).minHeight)
      );
      expect(flat(screen.getByTestId('metrics-trend-header')).minHeight).toBe(header);
      const clean = Number(flat(screen.getByTestId('metrics-trend-clean')).minHeight);
      const chart = Number(flat(screen.getByTestId('trend-chart-box')).height);
      return [Number(card.padding ?? 0) * 2 + header + gap + clean + gap + chart];
    });
    const g = flat(screen.getByTestId('analytics-metrics'));
    const blockGap = Number(g.gap ?? 0);
    const toggle = Number(flat(screen.getByTestId('analytics-range')).minHeight);
    const chrome = 2 * (Number(g.borderWidth) + Number(g.padding)) + toggle + blockGap;
    return chrome + cards.reduce((a, b) => a + b, 0) + blockGap * (cards.length - 1);
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
  ])('the whole group, toggle and outline included, takes at most three quarters of a %s window', async (_name, width, height, fontScale) => {
    setWindow(width, height, fontScale);
    await draw(group({ sums: windowSums(drives(4), null), trend: trend(drives(4), [], 'week', NOW) }));
    const drawn = drawnHeight();
    const l = mainLayout(height, Math.min(fontScale, 2));
    expect(drawn).toBeLessThanOrEqual(height * METRICS_MAX_SHARE);
    // The layout model agrees with what was drawn.
    expect(metricsBlockHeight(l, l.plot > 0 ? MAIN_BLOCK : NO_CHART_BLOCK)).toBeCloseTo(drawn, 5);
    // Driving's five numbers, and the clean rate as a sixth while the Trends card is left out.
    expect(screen.getAllByTestId(/^metric-[a-z-]+-value$/)).toHaveLength(l.plot > 0 ? 5 : 6);
    // With room, the chart is drawn at the plot height the layout gave it.
    if (l.plot > 0) expect(screen.getByTestId('trend-chart').props.height).toBe(l.plot);
    else expect(screen.queryByTestId('metrics-trend')).toBeNull();
  });

  test('the chart takes the room left: the standard cards with the tallest chart on the tallest phones, and a chart on every common phone', () => {
    expect(mainLayout(932, 1)).toMatchObject({ name: 'grid', perRow: 2, textScale: 1, plot: 120 });
    expect(mainLayout(844, 1)).toMatchObject({ name: 'grid', perRow: 2, textScale: 1, plot: 120 });
    for (const h of [932, 844, 740, 667, 640]) {
      const l = mainLayout(h, 1);
      expect(l.plot).toBeGreaterThan(0);
      expect(metricsBlockHeight(l)).toBeLessThanOrEqual(h * METRICS_MAX_SHARE);
    }
    // The block is the Driving card's five cells and the Trends card, in the range group.
    const l = mainLayout(844, 1);
    expect(metricsBlockHeight(l)).toBe(metricsBlockHeight(l, { cards: [5], grouped: true }));
    // The group adds its outline, its padding and the toggle with a gap under it.
    expect(metricsBlockHeight(l) - metricsBlockHeight(l, { cards: [5], grouped: false })).toBe(rangeGroupChrome(l));
    expect(rangeGroupChrome(l)).toBe(2 * (RANGE_GROUP_BORDER + RANGE_GROUP_PAD) + pickerHeight(1) + l.blockGap);
    // The chrome counts against the chart: the same window without it would grow the plot or keep it, never shrink it.
    const loose = metricsLayout(568, 1, { ...MAIN_BLOCK, grouped: false });
    expect(mainLayout(568, 1).plot).toBeLessThanOrEqual(loose.plot);
    // Under three quarters of a 568 pt phone at 2× too.
    expect(metricsBlockHeight(mainLayout(568, 2), mainLayout(568, 2).plot > 0 ? MAIN_BLOCK : NO_CHART_BLOCK)).toBeLessThanOrEqual(568 * METRICS_MAX_SHARE);
  });

  test('no room for the chart: the Trends card is left out, Driving takes the clean rate, and the text size comes first', async () => {
    const big = mainLayout(740, 2);
    expect(big.textScale).toBe(2);
    expect(metricsBlockHeight(big, big.plot > 0 ? MAIN_BLOCK : NO_CHART_BLOCK)).toBeLessThanOrEqual(740 * METRICS_MAX_SHARE);
    // Too tall even as a row: the block's text stops growing where it fits, never below 1×.
    const capped = [300, 340, 380, 420].map((h) => [h, mainLayout(h, 2)] as const);
    expect(capped.some(([, l]) => l.textScale < 2)).toBe(true);
    for (const [h, l] of capped) {
      expect(l.plot).toBe(0);
      expect(l.textScale).toBeGreaterThanOrEqual(1);
      if (l.textScale > 1) expect(metricsBlockHeight(l, NO_CHART_BLOCK)).toBeLessThanOrEqual(h * METRICS_MAX_SHARE);
    }

    const tight = [568, 520, 480, 440, 400].find((h) => mainLayout(h, 2).plot === 0)!;
    expect(tight).toBeDefined();
    setWindow(390, tight, 2);
    const sums = { ...windowSums(drives(4, 5, { clean: true }), null) };
    await draw(group({ sums, trend: EMPTY_TREND }));
    expect(screen.queryByTestId('metrics-trend')).toBeNull();
    expect(screen.getByTestId('metrics-driving')).toBeOnTheScreen();
    expect(screen.getByTestId('metric-clean-rate-value')).toHaveTextContent('100 %');
    expect(screen.getByLabelText('Clean rate, 100 percent')).toBeOnTheScreen();
    expect(drivingGroup(sums, 'mi', true).cells.map((c) => c.key)).toEqual(['drives', 'drive-time', 'distance', 'avg-drive', 'speed', 'clean-rate']);
  });

  test('a short last row keeps the grid: its cell stays one column wide, an empty column beside it', async () => {
    const spacers = (row: El): El[] => row.children.flatMap((n) => (typeof n !== 'string' && !n.props.testID ? [n as El] : []));
    await draw(group({ sums: windowSums(drives(4), null), trend: EMPTY_TREND }));
    // 2 × 2: Drives and Drive time, Distance and Avg drive, then Avg speed beside an empty column.
    const last = screen.getByTestId('metrics-driving-row-2');
    expect(cellsIn(last).map((c) => c.props.testID)).toEqual(['metric-speed']);
    expect(spacers(last)).toHaveLength(1);
    expect(flat(spacers(last)[0]!).flex).toBe(1);
    expect(flat(screen.getByTestId('metric-speed')).flex).toBe(1);
    expect(spacers(screen.getByTestId('metrics-driving-row-0'))).toHaveLength(0);
    // A row of four (the shortest windows, the largest text): the fifth cell (or the fifth and the clean rate) and empty columns.
    const short = [568, 520, 480, 440, 400, 360].find((h) => mainLayout(h, 1.3).perRow === 4)!;
    expect(short).toBeDefined();
    setWindow(390, short, 1.3);
    await draw(group({ sums: windowSums(drives(4), null), trend: EMPTY_TREND }));
    const cells = mainLayout(short, 1.3).plot > 0 ? 5 : 6;
    expect(screen.getAllByTestId(/^metrics-driving-row-/)).toHaveLength(2);
    expect(cellsIn(screen.getByTestId('metrics-driving-row-0'))).toHaveLength(4);
    expect(cellsIn(screen.getByTestId('metrics-driving-row-1'))).toHaveLength(cells - 4);
    expect(spacers(screen.getByTestId('metrics-driving-row-1'))).toHaveLength(8 - cells);
  });

  test('large text never draws a number or caption smaller than 1×: the row of four wraps its captions to two lines, and every fit has a floor', async () => {
    setWindow(390, 844, 2);
    await draw(group({ sums: windowSums(drives(4), null), trend: trend(drives(4), [], 'week', NOW) }));
    const l = mainLayout(844, 2);
    for (const el of screen.getAllByTestId(/^metric-[a-z-]+-caption$/)) {
      expect(el.props).toMatchObject({ numberOfLines: l.perRow === 4 ? 2 : 1, minimumFontScale: 0.85 });
      // 14 pt label at 2×, floored at 0.85: still above the 14 pt it is at 1×
      expect(Number(flat(el).fontSize) * Number(el.props.minimumFontScale)).toBeGreaterThan(tokens.type.label.fontSize);
    }
    for (const el of screen.getAllByTestId(/^metric-[a-z-]+-value$/)) expect(el.props.minimumFontScale).toBe(0.7);
    setWindow(390, 844, 1);
    await draw(group({ sums: windowSums(drives(4), null), trend: trend(drives(4), [], 'week', NOW) }));
    expect(screen.getByTestId('metric-speed-caption').props.numberOfLines).toBe(mainLayout(844, 1).perRow === 4 ? 2 : 1);
  });

  test('at 390 × 844 a 2 × 2 cell has room for "1,204 mi" in the display face, inside the group', () => {
    // Half the card's inner width (the gutters, the group's outline and padding, the card's padding), less the gap between the two cells.
    const { pad, colGap } = mainLayout(844, 1);
    const inner = 390 - 2 * (tokens.space.lg + RANGE_GROUP_BORDER + RANGE_GROUP_PAD + pad) - colGap;
    // "1,204" in 28 pt tabular figures and " mi" in 13 pt run about 110 pt.
    expect(inner / 2).toBeGreaterThanOrEqual(140);
  });

  test('the trend chart spans the card’s inside within the group', async () => {
    await draw(group({ sums: windowSums(drives(4), null), trend: trend(drives(4), [], 'week', NOW) }));
    const l = mainLayout(844, 1);
    const box = flat(screen.getByTestId('trend-chart-box'));
    expect(box.width).toBe(390 - 2 * (tokens.space.lg + RANGE_GROUP_BORDER + RANGE_GROUP_PAD + l.pad));
  });
});

describe('CategorySheet', () => {
  // Four 12 mi drives with a hard brake each (30 slowdowns apiece); the second one clean.
  const list = drives(4).map((d, i) => (i === 1 ? { ...d, clean: true, counts: { ...d.counts, hardBrake: 0 } } : d));
  const sums = windowSums(list, null);
  const props = {
    visible: true,
    onClose: jest.fn(),
    last90: { drives: 4, miles: 48 },
    sums,
    range: 'week' as const,
    onRange: jest.fn(),
    dashpalPaired: true,
    onPairDashpal: jest.fn(),
  };

  test("each category's numbers over the range: its events against its chances, never points", () => {
    expect(Object.fromEntries(AXES.map((a) => [a.key, categoryGroup(a.key, sums, 'week', 'mi').cells.map((c) => c.caption)]))).toEqual({
      speed: ['Speeding events', 'Over the limit', 'With a limit'],
      braking: ['Hard brakes', 'Slowdowns'],
      acceleration: ['Hard starts', 'Speed-ups'],
      turning: ['Sharp turns', 'Turns'],
      attention: ['Eyes off road', 'Drowsy', 'DashPal miles'],
      phone: ['Phone pickups', 'Time in hand'],
    });
    for (const a of AXES) {
      for (const c of categoryGroup(a.key, sums, 'month', 'km').cells) {
        expect(`${c.caption} ${c.metric.value} ${c.metric.unit} ${c.metric.spoken}`).not.toMatch(/pts|point/i);
      }
    }
    expect(categoryGroup('braking', sums, 'week', 'mi')).toMatchObject({ key: 'braking', title: 'Last 7 days' });
    expect(categoryGroup('braking', sums, 'day', 'mi').title).toBe('Last 24 hours');
    expect(categoryGroup('braking', sums, 'week', 'km').cells.map((c) => c.metric.value)).toEqual(['3', '120']);
    expect(categoryGroup('speed', { ...sums, speedingS: 95, limitS: 4800 }, 'week', 'mi').cells.map((c) => `${c.metric.value} ${c.metric.unit}`)).toEqual([
      '0 ',
      '2 min',
      '1.3 h',
    ]);
    expect(categoryTitle('speed', 88)).toBe('Speed · 88');
    expect(categoryTitle('turning', null)).toBe('Turning · —');
  });

  test('the rate line: how often it slipped per chance, "(estimated)" while old drives are in the range', () => {
    const s = { ...EMPTY_WINDOW, drives: 3 };
    expect(rateLine('braking', { ...s, hardBrake: 3, slowdowns: 411 })).toBe('1 hard brake per 137 slowdowns');
    expect(rateLine('braking', { ...s, hardBrake: 0, slowdowns: 410 })).toBe('No hard brakes in 410 slowdowns');
    expect(rateLine('braking', { ...s, hardBrake: 1, slowdowns: 1 })).toBe('A hard brake on your only slowdown');
    expect(rateLine('braking', { ...s, hardBrake: 0, slowdowns: 1 })).toBe('No hard brakes in 1 slowdown');
    expect(rateLine('braking', { ...s, hardBrake: 0, slowdowns: 0 })).toBeNull();
    expect(rateLine('acceleration', { ...s, hardAccel: 2, speedups: 250 })).toBe('1 hard start per 125 speed-ups');
    expect(rateLine('acceleration', { ...s, hardAccel: 0, speedups: 12 })).toBe('No hard starts in 12 speed-ups');
    expect(rateLine('turning', { ...s, hardCorner: 0, turns: 85 })).toBe('No sharp turns in 85 turns');
    expect(rateLine('turning', { ...s, hardCorner: 1, turns: 40 })).toBe('1 sharp turn per 40 turns');
    expect(rateLine('speed', { ...s, speedingS: 24, limitS: 1200 })).toBe('Over the limit 2% of the time');
    expect(rateLine('speed', { ...s, speedingS: 0, limitS: 1200 })).toBe('Never over the limit');
    expect(rateLine('speed', { ...s, speedingS: 1, limitS: 1200 })).toBe('Over the limit under 1% of the time');
    expect(rateLine('speed', { ...s, speedingS: 0, limitS: 0 })).toBeNull();
    expect(rateLine('attention', s)).toBeNull();
    expect(rateLine('braking', { ...s, hardBrake: 3, slowdowns: 411, exposureEstimated: true })).toBe('1 hard brake per 137 slowdowns (estimated)');
    // Phone use: pickups per hour at driving speed; never estimated; nothing before a drive was watched.
    expect(rateLine('phone', { ...s, pickups: 2, phoneS: 18_000 })).toBe('0.4 pickups an hour at driving speed');
    expect(rateLine('phone', { ...s, pickups: 3, phoneS: 3600 })).toBe('3.0 pickups an hour at driving speed');
    expect(rateLine('phone', { ...s, pickups: 30, phoneS: 2400 })).toBe('45 pickups an hour at driving speed');
    expect(rateLine('phone', { ...s, pickups: 1, phoneS: 40_000 })).toBe('Under 0.1 pickups an hour at driving speed');
    expect(rateLine('phone', { ...s, pickups: 0, phoneS: 11_520 })).toBe('No pickups in 3.2 h at driving speed');
    expect(rateLine('phone', { ...s, pickups: 0, phoneS: 2700 })).toBe('No pickups in 45 min at driving speed');
    expect(rateLine('phone', { ...s, pickups: 0, phoneS: 0 })).toBeNull();
    expect(rateLine('phone', { ...s, pickups: 2, phoneS: 18_000, exposureEstimated: true })).toBe('0.4 pickups an hour at driving speed');
    for (const line of [rateLine('braking', { ...s, hardBrake: 3, slowdowns: 411 }), rateLine('speed', { ...s, speedingS: 24, limitS: 1200 })]) expect(line).not.toMatch(/—|!/);
  });

  test('Braking: its name and score, its own verdict, the range, its numbers and its rate line, with no points anywhere', async () => {
    const onRange = jest.fn();
    const onClose = jest.fn();
    await draw(<CategorySheet {...props} axis="braking" score={72} onRange={onRange} onClose={onClose} />);
    expect(screen.getByRole('header', { name: 'Braking · 72' })).toBeOnTheScreen();
    expect(screen.getByText('Score out of 100, last 90 days')).toBeOnTheScreen();
    expect(screen.getByLabelText('Fair. Brake more gently. Leave more room so you can brake gently.')).toBeOnTheScreen();
    expect(screen.getByTestId('category-coaching-icon')).toHaveStyle({ color: light.warning });
    expect(screen.getByTestId('metrics-braking-title')).toHaveTextContent('Last 7 days');
    expect(screen.getByTestId('metric-brakes-value')).toHaveTextContent('3');
    expect(screen.getByTestId('metric-slowdowns-value')).toHaveTextContent('120');
    expect(screen.getByTestId('category-rate')).toHaveTextContent('1 hard brake per 40 slowdowns');
    expect(screen.queryByText(/\/100|per 100/)).toBeNull();
    expect(screen.queryByTestId('category-best')).toBeNull();
    expect(screen.queryByText(/pts|points/i)).toBeNull();
    expect(screen.getByRole('tab', { name: 'Week' })).toBeSelected();
    await press(screen.getByRole('tab', { name: 'Month' }));
    expect(onRange).toHaveBeenCalledWith('month');
    await press(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(onClose).toHaveBeenCalled();
  });

  test('Attention shows DashPal’s counts and watched distance, with no rate line', async () => {
    await draw(<CategorySheet {...props} axis="attention" score={55} sums={{ ...sums, eyesOff: 2, drowsy: 1, watchedMiles: 12 }} />);
    expect(screen.getByRole('header', { name: 'Attention · 55' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Poor. Stay focused. Eyes on the road, and pull over when tired.')).toBeOnTheScreen();
    expect(screen.getByTestId('metric-eyes-off-value')).toHaveTextContent('2');
    expect(screen.getByTestId('metric-drowsy-value')).toHaveTextContent('1');
    expect(screen.getByTestId('metric-watched-value')).toHaveTextContent('12.0 mi');
    expect(screen.queryByTestId('category-rate')).toBeNull();
    expect(screen.getByTestId('category-coaching-icon')).toHaveStyle({ color: light.danger });
  });

  test('Attention without a DashPal says where it comes from and offers to set one up; with one but no watched drives, says so', async () => {
    const onPairDashpal = jest.fn();
    await draw(<CategorySheet {...props} axis="attention" score={null} dashpalPaired={false} onPairDashpal={onPairDashpal} />);
    expect(screen.getByRole('header', { name: 'Attention' })).toBeOnTheScreen();
    expect(screen.getByText('Attention comes from DashPal')).toBeOnTheScreen();
    expect(screen.getByText('Pair a DashPal to get a score for how focused you stay on the road.')).toBeOnTheScreen();
    expect(screen.queryByTestId('category-range')).toBeNull();
    await press(screen.getByRole('button', { name: 'Set up DashPal' }));
    expect(onPairDashpal).toHaveBeenCalled();

    await draw(<CategorySheet {...props} axis="attention" score={null} />);
    expect(screen.getByText('No DashPal drives yet')).toBeOnTheScreen();
    expect(screen.getByTestId('category-range')).toBeOnTheScreen();
  });

  test('no drives in the range: "No data yet" in place of the numbers, and no verdict without a score', async () => {
    await draw(<CategorySheet {...props} axis="braking" score={null} last90={{ drives: 0, miles: 0 }} sums={EMPTY_WINDOW} />);
    expect(screen.getByRole('header', { name: 'Braking · —' })).toBeOnTheScreen();
    expect(screen.getByTestId('category-empty')).toBeOnTheScreen();
    expect(screen.getByText('No data yet')).toBeOnTheScreen();
    expect(screen.getByText('No drives in the last 7 days. Your numbers show up here after a drive.')).toBeOnTheScreen();
    expect(screen.queryByTestId('category-coaching')).toBeNull();
    expect(screen.queryByTestId('metrics-braking')).toBeNull();
    // The range still switches, so an older drive can be found.
    expect(screen.getByRole('tab', { name: 'Week' })).toBeSelected();
    // A 90-day score with an empty range keeps its verdict.
    await draw(<CategorySheet {...props} axis="speed" score={60} sums={EMPTY_WINDOW} range="day" />);
    expect(screen.getByTestId('category-coaching')).toBeOnTheScreen();
    expect(screen.getByText('No drives in the last 24 hours. Your numbers show up here after a drive.')).toBeOnTheScreen();
    expect(screen.queryByTestId('category-best')).toBeNull();
  });

  test('Phone use: its score, its tip, the range’s pickups and time in hand, pickups an hour at driving speed, and how a pickup is judged', async () => {
    const phoneSums = { ...sums, pickups: 3, inHandS: 75, phoneS: 10_800 };
    await draw(<CategorySheet {...props} axis="phone" score={64} sums={phoneSums} />);
    expect(screen.getByRole('header', { name: 'Phone use · 64' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Fair. Phone down while driving. Put your phone away before you pull out.')).toBeOnTheScreen();
    expect(screen.getByTestId('metric-phone-pickups-value')).toHaveTextContent('3');
    expect(screen.getByTestId('metric-phone-in-hand-value')).toHaveTextContent('1 min');
    expect(screen.getByLabelText('Time in hand, 1 minute')).toBeOnTheScreen();
    expect(screen.getByTestId('category-rate')).toHaveTextContent('1.0 pickups an hour at driving speed');
    const how = screen.getByTestId('category-phone-how');
    expect(within(how).getByText("A pickup counts once the car is going 10 mph or more. After that, every second your phone is in your hand while you're moving counts too.")).toBeOnTheScreen();
    expect(within(how).getByText("Put it down and pick it up again within 10 s and it's still one pickup.")).toBeOnTheScreen();
    expect(screen.queryByText(/—|!|pts|points/)).toBeNull();
  });

  test('Phone use in kilometres says its speed in km/h; other categories have no such lines', async () => {
    expect(analyticsCopy.category.phoneHow('km')[0]).toBe(
      "A pickup counts once the car is going 16 km/h or more. After that, every second your phone is in your hand while you're moving counts too."
    );
    await draw(<CategorySheet {...props} axis="braking" score={72} />);
    expect(screen.queryByTestId('category-phone-how')).toBeNull();
  });

  test('Phone use before any drive in the range was watched: no score, no verdict, and its numbers come with the next drive', async () => {
    await draw(<CategorySheet {...props} axis="phone" score={null} />);
    expect(screen.getByRole('header', { name: 'Phone use · —' })).toBeOnTheScreen();
    expect(screen.queryByTestId('category-coaching')).toBeNull();
    expect(screen.getByText('No phone data yet')).toBeOnTheScreen();
    expect(screen.getByText('Your Phone use numbers show up here after your next drive.')).toBeOnTheScreen();
    expect(screen.queryByTestId('metrics-phone')).toBeNull();
    expect(screen.queryByTestId('category-rate')).toBeNull();
    // How it is judged still shows, and the range still switches.
    expect(screen.getByTestId('category-phone-how')).toBeOnTheScreen();
    expect(screen.getByTestId('category-range')).toBeOnTheScreen();
    // No drives at all: the plain empty state.
    await draw(<CategorySheet {...props} axis="phone" score={null} sums={EMPTY_WINDOW} />);
    expect(screen.getByText('No data yet')).toBeOnTheScreen();
  });

  test('a good category gets a compliment; too little driving or no score gets the wait line', async () => {
    await draw(<CategorySheet {...props} axis="turning" score={100} />);
    expect(screen.getByLabelText('Good. Driving well. Keep it up.')).toBeOnTheScreen();
    await draw(<CategorySheet {...props} axis="turning" score={null} />);
    expect(screen.getByRole('header', { name: 'Turning · —' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Tips are on the way. Drive a few more times to get tips here.')).toBeOnTheScreen();
    await draw(<CategorySheet {...props} axis="speed" score={40} last90={{ drives: 1, miles: 5 }} />);
    expect(screen.getByLabelText('Tips are on the way. Drive a few more times to get tips here.')).toBeOnTheScreen();
  });

  test.each([
    [844, 1],
    [568, 1],
    [568, 2],
    [640, 3],
  ])("its numbers keep the metrics' rule: at most three quarters of a %d pt window (text %d×)", async (height, fontScale) => {
    setWindow(390, height, fontScale);
    const shape = { cards: [3], chart: false, grouped: false };
    const l = metricsLayout(height, Math.min(fontScale, 2), shape);
    expect(l.plot).toBe(0);
    expect(metricsBlockHeight(l, shape)).toBeLessThanOrEqual(height * METRICS_MAX_SHARE);
    await draw(<CategorySheet {...props} axis="speed" score={88} />);
    // The card drawn is the one measured.
    const card = flat(screen.getByTestId('metrics-speed'));
    expect(card.padding).toBe(l.pad);
    expect(Number(flat(screen.getByTestId('metrics-speed-title')).lineHeight)).toBeCloseTo(Number(metricsText(l).title.lineHeight), 5);
  });
});

describe('TrendCard', () => {
  // NOW is Monday 15:00. Sunday: 30 mi, two hard brakes and a speeding; Monday: 10 mi, none.
  const list = [
    drive({ clientTripId: 'm', startedAt: NOW - 2 * HOUR, miles: 10, counts: { ...drive().counts, hardBrake: 0 } }),
    drive({ clientTripId: 's', startedAt: NOW - 20 * HOUR, miles: 30, counts: { ...drive().counts, hardBrake: 2, speeding: 1 } }),
  ];
  const events = [
    { id: 'b1', type: 'hard_brake' as const, tier: 'severe' as const, startedAt: NOW - 20 * HOUR + 60_000, durationS: 0, status: 'active' as const },
    { id: 'b2', type: 'hard_brake' as const, tier: 'severe' as const, startedAt: NOW - 20 * HOUR + 120_000, durationS: 0, status: 'active' as const },
    { id: 's1', type: 'speeding' as const, tier: 'severe' as const, startedAt: NOW - 20 * HOUR + 180_000, durationS: 20, status: 'active' as const },
  ];
  const data = trend(list, events, 'week', NOW);
  const rated = (at: number) => Math.round(ratingAt(toRatingDrives(list, events), at).rating!);

  test('titled Trends; Score by default: the Safety Rating as of each day, one line in the page ink, a dot per point, the latest labelled, weekday ticks', async () => {
    await draw(<MetricsCards sums={windowSums(list, null)} trend={data} range="week" onRange={jest.fn()} />);
    expect(screen.getByTestId('metrics-trend-title')).toHaveTextContent('Trends');
    expect(screen.getByRole('tab', { name: 'Score' })).toBeSelected();
    expect(within(screen.getByTestId('metrics-trend')).getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByLabelText('Trend series')).toBeOnTheScreen();
    // The SVG renderer holds colours as ARGB numbers: the page ink, fully opaque.
    expect(screen.getByTestId('trend-line', { includeHiddenElements: true }).props.stroke).toMatchObject({ payload: (0xff000000 | parseInt(light.text.slice(1), 16)) >>> 0 });
    // Sunday's 90 days hold 30 mi (ranked), Monday's 40; the days before hold none.
    expect(screen.getAllByTestId('trend-dot', { includeHiddenElements: true })).toHaveLength(2);
    const sunday = rated(new Date(NOW).setHours(0, 0, 0, 0) - 1);
    const monday = rated(NOW);
    expect(data.series.score.map((p) => p.value)).toEqual([sunday, monday]);
    expect(sunday).toBeLessThan(100);
    expect(screen.getByTestId('trend-latest', { includeHiddenElements: true })).toHaveTextContent(String(monday));
    expect(screen.getAllByTestId('trend-tick', { includeHiddenElements: true }).map((t) => t.props.children)).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S', 'M']);
    expect(screen.getByTestId('trend-chart-box')).toHaveAccessibleName(new RegExp(`^Safety Rating by day\\. Lowest ${Math.min(sunday, monday)} `));
  });

  test('the picker switches the series: Events per mile on each day with drives', async () => {
    await draw(<MetricsCards sums={windowSums(list, null)} trend={data} range="week" onRange={jest.fn()} />);
    await press(screen.getByRole('tab', { name: 'Events' }));
    expect(screen.getByRole('tab', { name: 'Events' })).toBeSelected();
    // Sunday: 3 events over 30 mi; Monday none over 10.
    expect(screen.getByTestId('trend-chart-box')).toHaveAccessibleName('Events per mile by day. Lowest 0 events per mile today, latest 0 events per mile, trending down.');
    expect(screen.getByTestId('trend-latest', { includeHiddenElements: true })).toHaveTextContent('0 events/mile');
  });

  test('a Y axis down the left labels the three guides, top to bottom, for each series', async () => {
    await draw(<MetricsCards sums={windowSums(list, null)} trend={data} range="week" onRange={jest.fn()} />);
    const labels = () => screen.getAllByTestId('trend-y-label', { includeHiddenElements: true }).map((t) => t.props.children);
    expect(labels()).toEqual(['100', '50', '0']);
    await press(screen.getByRole('tab', { name: 'Events' }));
    // 0 and 0.1 a mile, padded by at least 0.05 and never below 0: 0 to 0.15.
    expect(labels()).toEqual(['0.15', '0.08', '0']);
    expect(axisTicks('events', 0, 2.5)).toEqual(['2.5', '1.3', '0']);
    expect(axisTicks('events', 0, 14)).toEqual(['14', '7', '0']);
    expect(axisTicks('events', 0, 0.05)).toEqual(['0.05', '0.03', '0']);
    expect(axisValue('score', 88.4)).toBe('88');
    // The plot is what the axis leaves of the card's inside.
    expect(axisWidth(['1,263', '1,165', '1,068'], 12)).toBe(Math.ceil(5 * 12 * 0.6) + AXIS_GAP);
  });

  test('in kilometres, Events are per kilometre', async () => {
    publishUnits('km');
    await draw(<MetricsCards sums={windowSums(list, null)} trend={data} range="week" onRange={jest.fn()} />);
    await press(screen.getByRole('tab', { name: 'Events' }));
    expect(screen.getByTestId('trend-chart-box')).toHaveAccessibleName('Events per kilometer by day. Lowest 0 events per kilometer today, latest 0 events per kilometer, trending down.');
    expect(screen.getByTestId('trend-latest', { includeHiddenElements: true })).toHaveTextContent('0 events/km');
    // 0.1 a mile is 0.062 a kilometre.
    expect(eventsPer(0.1, 'km')).toBeCloseTo(0.1 / 1.609344, 9);
    expect(eventsPer(0.1, 'mi')).toBe(0.1);
    const labels = screen.getAllByTestId('trend-y-label', { includeHiddenElements: true }).map((t) => t.props.children);
    // 0 to 0.062 + 0.05.
    expect(labels).toEqual(['0.11', '0.06', '0']);
  });

  test('no event counts under the chart: they live in the radar categories', async () => {
    await draw(<MetricsCards sums={windowSums(list, null)} trend={data} range="week" onRange={jest.fn()} />);
    expect(screen.queryByTestId('metrics-trend-row-0')).toBeNull();
    for (const key of ['speeding', 'brakes', 'starts', 'turns']) expect(within(screen.getByTestId('metrics-trend')).queryByTestId(`metric-${key}`)).toBeNull();
  });

  test('fewer than two points: one muted line in the chart’s place, at the same height', async () => {
    const one = trend(list.slice(0, 1), [], 'week', NOW);
    await draw(<MetricsCards sums={windowSums(list, null)} trend={one} range="week" onRange={jest.fn()} />);
    expect(screen.getByTestId('trend-empty')).toHaveTextContent('Not enough drives yet');
    expect(screen.queryByTestId('trend-chart')).toBeNull();
    const l = mainLayout(844, 1);
    expect(flat(screen.getByTestId('trend-chart-box')).height).toBe(chartBoxHeight(l));
    // Score waits for the events.
    await draw(<MetricsCards sums={windowSums(list, null)} trend={trend(list, null, 'week', NOW)} range="week" onRange={jest.fn()} />);
    expect(screen.getByTestId('trend-empty')).toBeOnTheScreen();
    await press(screen.getByRole('tab', { name: 'Events' }));
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
    expect(trendValue('score', 88)).toEqual({ value: '88', unit: '', spoken: '88' });
    expect(trendValue('events', 0.25)).toEqual({ value: '0.25', unit: 'events/mile', spoken: '0.25 events per mile' });
    expect(trendValue('events', 2.5)).toEqual({ value: '2.5', unit: 'events/mile', spoken: '2.5 events per mile' });
    expect(trendValue('events', 14.2)).toEqual({ value: '14', unit: 'events/mile', spoken: '14 events per mile' });
    expect(trendValue('events', 1)).toEqual({ value: '1', unit: 'event/mile', spoken: '1 event per mile' });
    expect(trendValue('events', 0)).toEqual({ value: '0', unit: 'events/mile', spoken: '0 events per mile' });
    expect(trendValue('events', 0.003)).toEqual({ value: '<0.01', unit: 'events/mile', spoken: 'under 0.01 events per mile' });
    expect(trendValue('events', 0.25, 'km')).toEqual({ value: '0.25', unit: 'events/km', spoken: '0.25 events per kilometer' });
    expect(trendLabel('score', [], 'day')).toBe('Not enough drives yet');
    expect(
      trendLabel(
        'score',
        [
          { x: 0, value: 90, when: 'in March' },
          { x: 1, value: 60, when: 'in April' },
        ],
        'month'
      )
    ).toBe('Safety Rating by month. Lowest 60 in April, latest 60, trending down.');
  });
});

describe('WhenYouDriveCard', () => {
  // NOW is Monday 15:00: these start Monday 14:00 (12p band) twice and Sunday 23:00 (9p band) once.
  const list = [
    drive({ clientTripId: 'a', startedAt: NOW - HOUR }),
    drive({ clientTripId: 'b', startedAt: NOW - HOUR - 60_000 }),
    drive({ clientTripId: 'c', startedAt: NOW - 16 * HOUR }),
  ];

  test('weekday rows by 3-hour columns, coloured by count on a five-step scale with a key, with the busiest slot', async () => {
    const grid = driveGrid(list, null);
    await draw(<WhenYouDriveCard grid={grid} />);
    expect(screen.getByText('When you drive')).toBeOnTheScreen();
    for (const tick of ['12a', '6a', '12p', '6p']) expect(screen.getByText(tick)).toBeOnTheScreen();
    expect(screen.queryByText('3a')).toBeNull();
    expect(screen.getAllByText('S')).toHaveLength(2);
    expect(screen.getByTestId('grid-0-4')).toHaveStyle({ backgroundColor: HEAT_RAMP.light[4] });
    expect(screen.getByTestId('analytics-grid-key')).toHaveTextContent('FewerMore');
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

  test('the steps are neutral greys running from faint to strong against the card in both schemes, the busiest at 7:1 or more', () => {
    for (const [scheme, c] of [['light', tokens.color.light], ['dark', tokens.color.dark]] as const) {
      for (const step of HEAT_RAMP[scheme]) expect(step.slice(1, 3).repeat(3)).toBe(step.slice(1));
      const ratios = HEAT_RAMP[scheme].map((step) => contrastRatio(step, c.surface));
      expect(ratios[0]!).toBeGreaterThan(1.3);
      expect(ratios[ratios.length - 1]!).toBeGreaterThanOrEqual(7);
      for (let i = 1; i < ratios.length; i++) expect(ratios[i]!).toBeGreaterThan(ratios[i - 1]!);
    }
  });

  test('no drives in the range: a short line, no grid', async () => {
    await draw(<WhenYouDriveCard grid={driveGrid([], null)} />);
    expect(screen.getByTestId('analytics-grid-empty')).toHaveTextContent('No drives yet');
    expect(screen.queryByTestId('grid-0-0')).toBeNull();
  });

  test('helpers', () => {
    expect(bandSpan(7)).toBe('9p–12a');
    expect(cellLevel(0, 3)).toBe(0);
    expect(cellLevel(3, 3)).toBe(5);
    expect(cellLevel(1, 3)).toBe(2);
    expect(cellLevel(1, 50)).toBe(1);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => cellLevel(n, 10))).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
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
  test('closed at first; opens to the drives titled by date and time', async () => {
    const onOpen = jest.fn();
    await draw(<DrivesCard drives={drives(3)} onOpen={onOpen} />);
    const toggle = screen.getByTestId('analytics-drives-toggle');
    expect(toggle).toHaveAccessibleName('Drives, 3');
    expect(screen.getByText('Drives · 3')).toBeOnTheScreen();
    expect(toggle.props.accessibilityState).toMatchObject({ expanded: false });
    expect(screen.queryByTestId('analytics-drives-list')).toBeNull();
    await press(toggle);
    expect(screen.getByTestId('analytics-drives-toggle').props.accessibilityState).toMatchObject({ expanded: true });
    expect(screen.getByText('Mon, Oct 5 · 2:00 PM')).toBeOnTheScreen();
    expect(screen.getAllByText('12.0 mi · 24 min · 1 event')).toHaveLength(3);
    // Rows wrap rather than cut the events off at large text.
    for (const id of ['analytics-drive-when', 'analytics-drive-line']) {
      for (const el of screen.getAllByTestId(id)) expect(el.props.numberOfLines).toBeUndefined();
    }
    await press(screen.getByTestId('analytics-drive-d1'));
    expect(onOpen).toHaveBeenCalledWith('d1');
  });

  test('ten rows, then Show more adds ten at a time', async () => {
    const list = drives(25, 5);
    await draw(<DrivesCard drives={list} onOpen={jest.fn()} />);
    await press(screen.getByTestId('analytics-drives-toggle'));
    expect(screen.getAllByTestId(/^analytics-drive-d/)).toHaveLength(DRIVES_PAGE);
    await press(screen.getByTestId('analytics-drives-more'));
    expect(screen.getAllByTestId(/^analytics-drive-d/)).toHaveLength(20);
    await press(screen.getByTestId('analytics-drives-more'));
    expect(screen.getAllByTestId(/^analytics-drive-d/)).toHaveLength(25);
    expect(screen.queryByTestId('analytics-drives-more')).toBeNull();
  });

  test('a long all-time list draws only the rows asked for: none while closed, then ten', async () => {
    const list = drives(600, 2);
    await draw(<DrivesCard drives={list} onOpen={jest.fn()} />);
    expect(screen.getByTestId('analytics-drives-toggle')).toHaveAccessibleName('Drives, 600');
    expect(screen.queryAllByTestId(/^analytics-drive-d/)).toHaveLength(0);
    await press(screen.getByTestId('analytics-drives-toggle'));
    expect(screen.getAllByTestId(/^analytics-drive-d/)).toHaveLength(DRIVES_PAGE);
  });

  test('a row reads as one button with the whole line in words', async () => {
    await draw(<DrivesCard drives={drives(1)} onOpen={jest.fn()} />);
    await press(screen.getByTestId('analytics-drives-toggle'));
    expect(screen.getByTestId('analytics-drive-d0')).toHaveAccessibleName('Mon, Oct 5 · 2:00 PM, 12.0 miles, 24 minutes, 1 event');
  });

  test('clean, eventless and kilometre lines', () => {
    const none = { ...drive().counts, hardBrake: 0 };
    expect(driveLine(drive({ clean: true, counts: none }), 'mi').text).toBe('12.0 mi · 24 min · Clean');
    expect(driveLine(drive({ clean: false, counts: none }), 'mi').text).toBe('12.0 mi · 24 min · No events');
    expect(driveLine(drive(), 'km').text).toBe('19.3 km · 24 min · 1 event');
  });

  test('no drives yet: the header says so and does not open', async () => {
    await draw(<DrivesCard drives={[]} onOpen={jest.fn()} />);
    const header = screen.getByTestId('analytics-drives-toggle');
    expect(header).toHaveAccessibleName('Drives, none yet');
    expect(header.props.accessibilityRole).toBe('header');
    expect(header.props.accessibilityState?.disabled).not.toBe(true);
    expect(screen.getByText('Drives · 0')).toBeOnTheScreen();
    expect(screen.getByTestId('analytics-drives-empty')).toHaveTextContent('No drives yet');
    await press(screen.getByTestId('analytics-drives-toggle'));
    expect(screen.queryByTestId('analytics-drives-list')).toBeNull();
  });

  test('none in the list but older drives archived (past 183 days): “in the last 6 months”, not “yet”', async () => {
    await draw(<DrivesCard drives={[]} onOpen={jest.fn()} archived />);
    expect(screen.getByTestId('analytics-drives-toggle')).toHaveAccessibleName('Drives, none in the last 6 months');
    expect(screen.getByText('Drives · 0')).toBeOnTheScreen();
    expect(screen.getByTestId('analytics-drives-empty')).toHaveTextContent('No drives in the last 6 months');
    // With drives listed the flag changes nothing.
    await draw(<DrivesCard drives={drives(2)} onOpen={jest.fn()} archived />);
    expect(screen.getByTestId('analytics-drives-toggle')).toHaveAccessibleName('Drives, 2');
  });
});

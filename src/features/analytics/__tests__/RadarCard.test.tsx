import { screen } from '@testing-library/react-native';
import { processColor } from 'react-native';

import { draw } from '@/features/drives/__fixtures__/drives';
import { tokens } from '@/ui/tokens';

import { NO_SCORES, SCORES } from '../__fixtures__/analytics';
import { AXES } from '../model';
import { analyticsCopy } from '../copy';
import { axisAt, RADAR_ZERO, RADAR_ZERO_MIN, radarGeometry, radarPoint, RadarCard, radiusFor, zeroRadius } from '../RadarCard';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

const light = tokens.color.light;
const opts = { includeHiddenElements: true };
const dot = (key: string) => screen.getByTestId(`radar-dot-${key}`, opts);
const edge = (i: number) => screen.getByTestId(`radar-edge-${i}`, opts);
const shape = () => {
  const d = String(screen.getByTestId('radar-shape', opts).props.d);
  const nums = d.replace(/[Mz]/gi, ' ').trim().split(/[\s,]+/).map(Number);
  return Array.from({ length: nums.length / 2 }, (_, i) => ({ x: nums[2 * i]!, y: nums[2 * i + 1]! }));
};
/** A colour as the native side sees it: one signed 32-bit number, as gradients hold it and as a fill's payload (unsigned). */
const argb = (c: string) => Number(processColor(c)) | 0;
const payload = (v: { payload: number }) => v.payload | 0;
const GREY = argb(light.textSubtle);
const INK = argb(light.text);
const SURFACE = argb(light.surface);
interface Gradient {
  name: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  gradient: number[];
  gradientUnits: number;
}
/** The edge gradients in the drawn tree (react-native-svg names them by their id). */
const gradients = (): Gradient[] => {
  const found: Gradient[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n === 'string') return;
    if (Array.isArray(n)) return n.forEach(walk);
    const node = n as { type?: string; props?: Record<string, unknown>; children?: unknown[] };
    if (node.type === 'RNSVGLinearGradient') found.push(node.props as unknown as Gradient);
    node.children?.forEach(walk);
  };
  walk(screen.toJSON());
  return found;
};
/** Whether an edge is stroked with a gradient (a brush reference) and not a flat colour. */
const fades = (i: number) => (edge(i).props.stroke as { type: number }).type === 1;
const flatStroke = (i: number) => payload(edge(i).props.stroke);

describe('RadarCard with scores that do not count', () => {
  test('all N/A: a perfect hexagon on the zero ring, six greyed dots, every edge grey, no gradients', async () => {
    await draw(<RadarCard dashpalPaired={false} rating={null} scores={NO_SCORES} onOpen={jest.fn()} />);
    const g = radarGeometry(390 - 4 * tokens.space.lg, 1);
    const pts = shape();
    expect(pts).toHaveLength(6);
    pts.forEach((p, i) => {
      const z = radarPoint(i, 6, zeroRadius(g.r), g.c);
      expect(p.x).toBeCloseTo(z.x, 0);
      expect(p.y).toBeCloseTo(z.y, 0);
    });
    for (const a of AXES) {
      // hollow: the card's colour inside a grey ring, a touch bigger than a scored dot, at full strength
      expect(payload(dot(a.key).props.fill)).toBe(SURFACE);
      expect(payload(dot(a.key).props.stroke)).toBe(GREY);
      expect(dot(a.key).props.strokeWidth).toBe(1.5);
      expect(dot(a.key).props.r).toBe(3.5);
      expect(dot(a.key).props.opacity).toBe(1);
    }
    for (let i = 0; i < 6; i++) {
      expect(fades(i)).toBe(false);
      expect(flatStroke(i)).toBe(GREY);
    }
    expect(gradients()).toHaveLength(0);
  });

  test('a lone N/A axis keeps its vertex at the 0 position; the two edges into it fade from the ink to the grey', async () => {
    await draw(<RadarCard dashpalPaired={false} rating={80} scores={SCORES} onOpen={jest.fn()} />);
    const g = radarGeometry(390 - 4 * tokens.space.lg, 1);
    const att = AXES.findIndex((a) => a.key === 'attention');
    const pts = shape();
    expect(pts).toHaveLength(6);
    const z = radarPoint(att, 6, zeroRadius(g.r), g.c);
    expect(pts[att]!.x).toBeCloseTo(z.x, 0);
    expect(pts[att]!.y).toBeCloseTo(z.y, 0);
    // the N/A dot is hollow (surface fill, grey ring); a scored one is a solid ink dot of r 3
    expect(payload(dot('attention').props.fill)).toBe(SURFACE);
    expect(payload(dot('attention').props.stroke)).toBe(GREY);
    expect(dot('attention').props.r).toBe(3.5);
    expect(dot('speed').props.r).toBe(3);
    expect(payload(dot('speed').props.fill)).toBe(INK);
    expect(dot('speed').props.opacity).toBe(1);
    // exactly the edge into it and the edge out of it fade, each running from the scored end to the N/A vertex
    const into = (att + 5) % 6;
    expect([0, 1, 2, 3, 4, 5].filter(fades)).toEqual([into, att].sort());
    const grads = gradients();
    expect(grads).toHaveLength(2);
    for (const gr of grads) {
      expect(gr.gradientUnits).toBe(1); // userSpaceOnUse
      expect(gr.gradient).toEqual([0, INK, 1, GREY]);
      expect(gr.x2).toBeCloseTo(pts[att]!.x, 0);
      expect(gr.y2).toBeCloseTo(pts[att]!.y, 0);
    }
    expect(grads.map((gr) => gr.name).sort()).toEqual([`radar-edge-${into}`, `radar-edge-${att}`].sort());
    // edges between two scores are the plain ink
    for (const i of [0, 1, 2, 3, 4, 5].filter((i) => i !== into && i !== att)) expect(flatStroke(i)).toBe(INK);
  });

  test('two N/A axes: the edge between them is grey throughout, the outer edges fade', async () => {
    await draw(<RadarCard dashpalPaired={false} rating={80} scores={{ ...SCORES, phone: null }} onOpen={jest.fn()} />);
    expect(AXES.findIndex((a) => a.key === 'attention')).toBe(3);
    expect(AXES.findIndex((a) => a.key === 'phone')).toBe(4);
    expect(shape()).toHaveLength(6);
    expect(fades(3)).toBe(false);
    expect(flatStroke(3)).toBe(GREY);
    expect(fades(2)).toBe(true);
    expect(fades(4)).toBe(true);
    expect(gradients()).toHaveLength(2);
  });

  test('a real score of 0 is a normal dot in the ink, with plain edges', async () => {
    await draw(<RadarCard dashpalPaired rating={80} scores={{ ...SCORES, braking: 0 }} onOpen={jest.fn()} />);
    expect(payload(dot('braking').props.fill)).toBe(INK);
    expect(dot('braking').props.opacity).toBe(1);
    expect(gradients()).toHaveLength(0);
  });

  test('the accessibility label is unchanged by the grey', async () => {
    await draw(<RadarCard dashpalPaired={false} rating={80} scores={SCORES} onOpen={jest.fn()} />);
    expect(
      screen.getByLabelText('Safety Rating 80 out of 100. Acceleration 95, Braking 72, Turning 100, Attention needs DashPal, Phone use 84, Speed 88.')
    ).toBeOnTheScreen();
  });
});

describe('the zero ring and the centre', () => {
  test('the zero ring is a share of the radius but never under the minimum', () => {
    expect(RADAR_ZERO_MIN).toBe(40);
    expect(zeroRadius(56)).toBe(40);
    expect(zeroRadius(200)).toBe(60);
    expect(zeroRadius(110)).toBe(40); // 33 pt of share is under the minimum
    expect(zeroRadius(150)).toBeCloseTo(RADAR_ZERO * 150, 5);
  });

  test('a score maps linearly from the zero ring (0) to the outer ring (100)', () => {
    for (const r of [56, 90, 110]) {
      expect(radiusFor(0, r)).toBe(zeroRadius(r));
      expect(radiusFor(null, r)).toBe(zeroRadius(r));
      expect(radiusFor(100, r)).toBe(r);
      expect(radiusFor(50, r)).toBeCloseTo((zeroRadius(r) + r) / 2, 5);
    }
  });

  test('a tap inside the zero ring opens nothing; just outside it opens the nearest axis', () => {
    const c = { x: 100, y: 100 };
    for (const r of [56, 110]) {
      expect(axisAt(c.x, c.y - zeroRadius(r) + 1, r, c)).toBeNull();
      expect(axisAt(c.x, c.y - zeroRadius(r) - 1, r, c)).toBe(0);
    }
  });

  test('the centre is the number at the stat size with "/100" under it, and no caption', async () => {
    await draw(<RadarCard dashpalPaired rating={80} scores={SCORES} onOpen={jest.fn()} />);
    const num = screen.getByTestId('radar-rating', opts);
    expect(num).toHaveTextContent('80');
    expect(num).toHaveStyle({ fontSize: 28, lineHeight: 32 });
    expect(screen.getByTestId('radar-out-of', opts)).toHaveTextContent('/100');
    expect(screen.getByTestId('radar-out-of', opts)).toHaveStyle({ fontSize: 12, textAlign: 'center' });
    expect(num).toHaveStyle({ textShadowRadius: 4 });
    // "Safety Rating" is no longer in the middle: only the footer's "Safety Rating · Last 90 days" and the chart's label carry it
    expect(screen.queryByText('Safety Rating', { includeHiddenElements: true })).toBeNull();
  });

  test('with no rating the centre is a dash alone', async () => {
    await draw(<RadarCard dashpalPaired={false} rating={null} scores={NO_SCORES} onOpen={jest.fn()} />);
    expect(screen.getByTestId('radar-rating', opts)).toHaveTextContent('—');
    expect(screen.queryByTestId('radar-out-of', opts)).toBeNull();
  });

  test('the footer names the rating and the window', async () => {
    await draw(<RadarCard dashpalPaired rating={80} scores={SCORES} onOpen={jest.fn()} />);
    expect(analyticsCopy.radar.ratingWindow).toBe('Safety Rating · Last 90 days');
    expect(screen.getByText('Safety Rating · Last 90 days')).toBeOnTheScreen();
  });
});

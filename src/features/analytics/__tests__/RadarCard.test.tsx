import { screen } from '@testing-library/react-native';
import { processColor } from 'react-native';

import { draw } from '@/features/drives/__fixtures__/drives';
import { tokens } from '@/ui/tokens';

import { NO_SCORES, SCORES } from '../__fixtures__/analytics';
import { AXES } from '../model';
import { RADAR_ZERO, radarGeometry, radarPoint, RadarCard } from '../RadarCard';

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
      const z = radarPoint(i, 6, g.r * RADAR_ZERO, g.c);
      expect(p.x).toBeCloseTo(z.x, 0);
      expect(p.y).toBeCloseTo(z.y, 0);
    });
    for (const a of AXES) {
      expect(payload(dot(a.key).props.fill)).toBe(GREY);
      expect(dot(a.key).props.opacity).toBeLessThan(1);
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
    const z = radarPoint(att, 6, g.r * RADAR_ZERO, g.c);
    expect(pts[att]!.x).toBeCloseTo(z.x, 0);
    expect(pts[att]!.y).toBeCloseTo(z.y, 0);
    // the N/A dot is grey and the same size; a scored one is the ink at full strength
    expect(payload(dot('attention').props.fill)).toBe(GREY);
    expect(dot('attention').props.r).toBe(dot('speed').props.r);
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

import { Ionicons } from '@expo/vector-icons';
import { fireEvent, screen, within } from '@testing-library/react-native';

import { draw, drive, event, ROUTE } from '../__fixtures__/drives';
import { DriveRow } from '../DriveRow';
import { accelChevrons, EventIcon } from '../EventIcon';
import { EVENT_ICON } from '../format';
import { RouteMap } from '../RouteMap';

const H = { includeHiddenElements: true } as const;
const glyph = (name: keyof typeof Ionicons.glyphMap) => String.fromCodePoint(Number(Ionicons.glyphMap[name]));
const ACCEL_STOCK = 'trending-up-outline' as const;

jest.mock('react-native-maps', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const pass = (name: string) => {
    const C = ({ children, testID, ...rest }: { children?: React.ReactNode; testID?: string }) => (
      <View testID={testID ?? name} {...rest}>
        {children}
      </View>
    );
    return C;
  };
  class MapView extends React.Component<{ children?: React.ReactNode }> {
    animateToRegion = jest.fn();
    render() {
      const { children, ...rest } = this.props;
      return (
        <View testID="map-view" {...rest}>
          {children}
        </View>
      );
    }
  }
  return { __esModule: true, default: MapView, Marker: pass('marker'), Polyline: pass('polyline') };
});

describe('the hard-acceleration glyph', () => {
  const parse = (points: string) => points.split(' ').map((p) => p.split(',').map(Number) as [number, number]);

  test('three chevrons growing left to right, the same angle, inside the 24-unit square', () => {
    const chevrons = accelChevrons().map(parse);
    expect(chevrons).toHaveLength(3);
    const heights = chevrons.map(([top, , bottom]) => bottom![1] - top![1]);
    expect(heights).toEqual([8, 14, 20]); // 40 %, 70 % and 100 % of the tallest
    const tips = chevrons.map(([, tip]) => tip![0]);
    expect(tips[0]).toBeLessThan(tips[1]!);
    expect(tips[1]).toBeLessThan(tips[2]!);
    // Every chevron points right (its point past its open ends) at the same angle.
    for (const [top, tip, bottom] of chevrons) {
      expect(tip![0]).toBeGreaterThan(top![0]);
      expect(top![0]).toBeCloseTo(bottom![0], 6);
      expect((tip![0] - top![0]) / ((bottom![1] - top![1]) / 2)).toBeCloseTo(0.8, 6);
      expect(tip![1]).toBe(12);
    }
    // Centred, with room for the 2.4-unit round stroke on every side.
    const xs = chevrons.flat().map(([x]) => x);
    const ys = chevrons.flat().map(([, y]) => y);
    expect(Math.min(...xs) - 1.2).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs) + 1.2).toBeLessThanOrEqual(24);
    expect(Math.min(...ys) - 1.2).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys) + 1.2).toBeLessThanOrEqual(24);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(12, 6);
  });

  test('EventIcon draws it for hard acceleration on the Ionicons footprint, and Ionicons for every other event', async () => {
    await draw(<EventIcon type="hard_accel" size={14} color="#123456" />);
    const svg = screen.getByTestId('accel-glyph', H);
    expect(svg).toHaveProp('width', 14);
    expect(svg).toHaveProp('height', 14);
    expect(screen.queryByText(glyph(ACCEL_STOCK), H)).toBeNull();

    await draw(<EventIcon type="hard_brake" size={14} color="#123456" />);
    expect(screen.getByText(glyph(EVENT_ICON.hard_brake), H)).toBeOnTheScreen();
    expect(screen.queryByTestId('accel-glyph', H)).toBeNull();
  });
});

test('a drive row (Home and Drive history) shows the chevrons for a hard acceleration', async () => {
  const d = drive({ clientTripId: 'x', counts: { ...drive().counts, hardBrake: 1, hardAccel: 2 } });
  await draw(<DriveRow drive={d} onPress={jest.fn()} testID="recent-x" />);
  const accel = screen.getByTestId('recent-x-event-hard_accel', H);
  expect(within(accel).getByTestId('accel-glyph', H)).toBeOnTheScreen();
  expect(within(accel).getByText('2', H)).toBeOnTheScreen();
  expect(within(accel).queryByText(glyph(ACCEL_STOCK), H)).toBeNull();
  // Spoken from the event's name, never the glyph.
  expect(screen.getByTestId('recent-x').props.accessibilityLabel).toContain('2 hard acceleration');
  expect(within(screen.getByTestId('recent-x-event-hard_brake', H)).getByText(glyph(EVENT_ICON.hard_brake), H)).toBeOnTheScreen();
});

test('a hard-acceleration pin on the summary map, and the card it opens, wear the chevrons', async () => {
  await draw(<RouteMap runs={[ROUTE]} events={[event({ id: 'a', type: 'hard_accel', tier: 'minor' })]} highlighted={null} />);
  const pin = screen.getByTestId('pin-a', H);
  expect(within(pin).getByTestId('accel-glyph', H)).toBeOnTheScreen();
  expect(within(pin).queryByText(glyph(ACCEL_STOCK), H)).toBeNull();
  await fireEvent.press(pin);
  expect(within(screen.getByTestId('map-event-card')).getByTestId('accel-glyph', H)).toBeOnTheScreen();
});

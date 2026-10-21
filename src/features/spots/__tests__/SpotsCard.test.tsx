import { screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { draw, press } from '@/features/drives/__fixtures__/drives';

import { problemSpot, spotsView } from '../__fixtures__/spots';
import { SPOT_INK } from '../ink';
import { SpotsCard } from '../SpotsCard';

describe('SpotsCard', () => {
  test.each([
    ['still loading', null],
    ['never computed', spotsView({ computed: false, active: [] })],
    ['too few drives and nothing to show', spotsView({ eligible: false, active: [] })],
  ] as const)('is hidden while %s', async (_, view) => {
    await draw(<SpotsCard view={view} onOpen={jest.fn()} />);
    expect(screen.queryByTestId('spots-card')).toBeNull();
  });

  test('with no spots: the title, its caption and one calm line', async () => {
    await draw(<SpotsCard view={spotsView({ active: [] })} onOpen={jest.fn()} />);
    expect(screen.getByRole('header', { name: 'Spots to watch' })).toBeOnTheScreen();
    expect(screen.getByText('Last 4 months')).toBeOnTheScreen();
    expect(screen.getByTestId('spots-empty')).toHaveTextContent('None right now. A place shows up here when the same thing keeps happening there.');
    expect(screen.queryByTestId('spots-cleared')).toBeNull();
  });

  test('a row per spot in rank order: its street (or direction), the kind and how often, and a disc in the spot ink', async () => {
    const onOpen = jest.fn();
    const view = spotsView({
      active: [
        problemSpot(),
        problemSpot({ id: 'hard_brake:e2', kind: 'hard_brake', label: null, headingDeg: 0, recentHits: 3, recentPasses: 7, limitMph: null, rank: 2, cleanStreak: 2 }),
      ],
    });
    await draw(<SpotsCard view={view} onOpen={onOpen} />);
    expect(screen.getByText('Dexter Ave N')).toBeOnTheScreen();
    expect(screen.getByText('Speeding · 4 of your last 6 drives here')).toBeOnTheScreen();
    expect(screen.getByText('Spot heading north')).toBeOnTheScreen();
    expect(screen.getByText('Hard braking · 3 of your last 7 drives here')).toBeOnTheScreen();
    // "Getting better" only once 2 clean drives in a row have passed it.
    expect(screen.queryByTestId('spot-better-speeding:e1', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByTestId('spot-better-hard_brake:e2', { includeHiddenElements: true })).toBeOnTheScreen();
    const discs = screen.getAllByTestId('spot-disc', { includeHiddenElements: true });
    expect(discs).toHaveLength(2);
    expect(StyleSheet.flatten(discs[0]!.props.style)).toMatchObject({ backgroundColor: SPOT_INK.light.line, width: 36 });

    const row = screen.getByTestId('spot-row-hard_brake:e2');
    expect(row).toHaveProp('accessibilityLabel', 'Spot heading north. Hard braking, heading north. 3 of your last 7 drives here. Getting better.');
    expect(row).toHaveProp('accessibilityHint', 'Opens what happens here');
    expect(screen.getByTestId('spot-row-speeding:e1')).toHaveProp('accessibilityLabel', 'Dexter Ave N. Speeding, heading south. 4 of your last 6 drives here.');
    await press(row);
    expect(onOpen).toHaveBeenCalledWith('hard_brake:e2');
  });

  test('a footnote for the spots cleared in the last 30 days, singular and plural', async () => {
    const one = await draw(<SpotsCard view={spotsView({ clearedRecently: 1 })} onOpen={jest.fn()} />);
    expect(screen.getByTestId('spots-cleared')).toHaveTextContent('1 spot cleared in the last 30 days. Nice driving.');
    await one.unmount();
    await draw(<SpotsCard view={spotsView({ active: [], clearedRecently: 2 })} onOpen={jest.fn()} />);
    expect(screen.getByTestId('spots-cleared')).toHaveTextContent('2 spots cleared in the last 30 days. Nice driving.');
  });

  test('with fewer than 10 drives the card still shows a spot it already has', async () => {
    await draw(<SpotsCard view={spotsView({ eligible: false })} onOpen={jest.fn()} />);
    expect(screen.getByTestId('spots-card')).toBeOnTheScreen();
  });
});

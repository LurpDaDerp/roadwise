import { screen } from '@testing-library/react-native';

import { publishUnits, resetUnitsForTests } from '@/data/queries/units';
import { draw, press } from '@/features/drives/__fixtures__/drives';
import { ThemeProvider } from '@/ui/theme';

import { problemSpot } from '../__fixtures__/spots';
import { SpotSheet } from '../SpotSheet';

afterEach(() => resetUnitsForTests());

describe('SpotSheet', () => {
  test('what happens and how often, the last time, the progress, a tip and the driving screen line', async () => {
    await draw(<SpotSheet spot={problemSpot()} visible onClose={jest.fn()} onOpenDrive={jest.fn()} />);
    expect(screen.getByText('Dexter Ave N')).toBeOnTheScreen();
    expect(screen.getByText('Speeding · heading south')).toBeOnTheScreen();
    expect(screen.getByText('Over the 35 mph limit')).toBeOnTheScreen();
    expect(screen.getByText('4 of your last 6 drives here')).toBeOnTheScreen();
    expect(screen.getByText('Last time')).toBeOnTheScreen();
    expect(screen.getByText(/^Tue, Oct 13 · 8:12\sAM$/)).toBeOnTheScreen();
    expect(screen.getByText('Clears after 5 clean drives in a row here')).toBeOnTheScreen();
    expect(screen.getByTestId('spot-tip')).toHaveTextContent('Ease off a little before you get here.');
    expect(screen.getByTestId('spot-hud-note')).toHaveTextContent('With RoadWise open, “Watch your speed here” shows as you come up to it.');
  });

  test('kilometres for a km driver', async () => {
    publishUnits('km');
    await draw(<SpotSheet spot={problemSpot()} visible onClose={jest.fn()} onOpenDrive={jest.fn()} />);
    expect(screen.getByText('Over the 56 km/h limit')).toBeOnTheScreen();
  });

  test('a clean run in progress says how many more clear it', async () => {
    await draw(
      <SpotSheet
        spot={problemSpot({ kind: 'hard_corner', cleanStreak: 2, cleanNeeded: 6, label: null, headingDeg: 270, limitMph: null })}
        visible
        onClose={jest.fn()}
        onOpenDrive={jest.fn()}
      />
    );
    expect(screen.getByText('Spot heading west')).toBeOnTheScreen();
    expect(screen.getByText('Sharp turns · heading west')).toBeOnTheScreen();
    expect(screen.getByText('Turning fast')).toBeOnTheScreen();
    expect(screen.getByText('2 clean drives in a row here')).toBeOnTheScreen();
    expect(screen.getByText('4 more and it clears')).toBeOnTheScreen();
    expect(screen.getByTestId('spot-tip')).toHaveTextContent('Slow down before the turn, not in it.');
    expect(screen.getByTestId('spot-hud-note')).toHaveTextContent('With RoadWise open, “Take this turn slower” shows as you come up to it.');
  });

  test('"Open drive" closes the sheet, then opens the drive the event last happened on', async () => {
    const calls: string[] = [];
    await draw(<SpotSheet spot={problemSpot()} visible onClose={() => calls.push('close')} onOpenDrive={(id) => calls.push(`open ${id}`)} />);
    const button = screen.getByTestId('spot-open-drive');
    expect(button).toHaveProp('accessibilityHint', "Open that drive's summary");
    await press(button);
    expect(calls).toEqual(['close', 'open trip-9']);
  });

  test('closes when its spot is gone', async () => {
    const { rerender } = await draw(<SpotSheet spot={problemSpot()} visible onClose={jest.fn()} onOpenDrive={jest.fn()} />);
    expect(screen.getByText('Over the 35 mph limit')).toBeOnTheScreen();
    await rerender(
      <ThemeProvider scheme="light" reduceMotion>
        <SpotSheet spot={null} visible onClose={jest.fn()} onOpenDrive={jest.fn()} />
      </ThemeProvider>
    );
    expect(screen.queryByText('Over the 35 mph limit')).toBeNull();
  });
});

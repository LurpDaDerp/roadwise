import { screen, within } from '@testing-library/react-native';

import { tokens } from '@/ui/tokens';

import { draw, drive, event, press, result } from '../__fixtures__/drives';
import { SummaryView, type SummaryViewProps } from '../SummaryView';

jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => true), shareAsync: jest.fn(async () => undefined) }));
jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn(async () => 'file:///card.png') }));

const props = (over: Partial<SummaryViewProps> = {}): SummaryViewProps => ({
  drive: drive(),
  events: [event()],
  fresh: false,
  notDrivingLeft: 2,
  safetyRating: 92,
  onBack: jest.fn(),
  onOpenDrive: jest.fn(),
  onReport: jest.fn(async () => undefined),
  onNotDriving: jest.fn(async () => undefined),
  ...over,
});

test('the breakdown is collapsed by default and expands in place', async () => {
  await draw(<SummaryView {...props()} />);
  expect(screen.getByLabelText('Points earned: +167 points')).toBeOnTheScreen();
  const toggle = screen.getByTestId('breakdown-toggle');
  expect(toggle).toBeCollapsed();
  expect(screen.queryByTestId('breakdown')).toBeNull();

  await press(toggle);
  expect(screen.getByTestId('breakdown-toggle')).toBeExpanded();
  const list = screen.getByTestId('breakdown');
  expect(within(list).getByText('Safe miles: 11.8 mi × 10')).toBeOnTheScreen();
  expect(within(list).getByText('Multiplier: streak ×1.20 · DMS ×1.25 → ×1.50 (cap)')).toBeOnTheScreen();
  expect(within(list).getByText('Hard brake · Minor')).toBeOnTheScreen();
  expect(within(list).getByText('Net total')).toBeOnTheScreen();

  await press(screen.getByTestId('breakdown-toggle'));
  expect(screen.queryByTestId('breakdown')).toBeNull();
});

test('tapping an event line selects it and circles it on the map', async () => {
  await draw(<SummaryView {...props()} />);
  await press(screen.getByTestId('breakdown-toggle'));
  expect(screen.queryByTestId('map-highlight-caption')).toBeNull();

  await press(screen.getByTestId('event-e1'));
  expect(screen.getByTestId('event-e1')).toBeSelected();
  expect(screen.getByTestId('map-highlight-caption')).toHaveTextContent(/^Circled on the map: Hard brake · Minor at /);

  await press(screen.getByTestId('event-e1'));
  expect(screen.queryByTestId('map-highlight-caption')).toBeNull();
});

test('an event outside the map (privacy zone) says so when tapped', async () => {
  await draw(<SummaryView {...props({ events: [event({ lat: null, lng: null })] })} />);
  await press(screen.getByTestId('breakdown-toggle'));
  await press(screen.getByTestId('event-e1'));
  expect(screen.getByTestId('map-highlight-caption')).toHaveTextContent(/isn't on the map/);
});

test('a negative drive shows red points with a true minus', async () => {
  const r = result({ net: -44 });
  await draw(<SummaryView {...props({ drive: drive({ pointsNet: -44, result: r }) })} />);
  const pts = screen.getByLabelText('Points this drive: −44 points');
  expect(pts).toBeOnTheScreen();
  expect(within(pts).getByText('−44')).toHaveStyle({ color: tokens.color.dark.danger });
});

test('an offline estimate is labelled and explains the missing breakdown', async () => {
  await draw(<SummaryView {...props({ drive: drive({ status: 'pending', estimate: true, pointsNet: 40, result: null }) })} />);
  expect(screen.getByTestId('estimate')).toBeOnTheScreen();
  expect(screen.getByText('Estimate')).toBeOnTheScreen();
  await press(screen.getByTestId('breakdown-toggle'));
  expect(screen.getByText('The full breakdown shows up once this drive is scored.')).toBeOnTheScreen();
});

test('a too-short drive says so instead of points', async () => {
  await draw(<SummaryView {...props({ drive: drive({ status: 'unscored', reason: 'too_short', pointsNet: 0, result: null }), events: [] })} />);
  expect(screen.getByText('Too short to score')).toBeOnTheScreen();
  expect(screen.queryByTestId('breakdown-toggle')).toBeNull();
});

test('the streak line and anything unlocked show under the points', async () => {
  const r = result({ achievements: ['first_drive'], progress: { ...result().progress, levelUp: true, level: 5 } });
  await draw(<SummaryView {...props({ drive: drive({ result: r }) })} />);
  expect(screen.getByText('Streak 11 · next drive ×1.22')).toBeOnTheScreen();
  expect(screen.getByTestId('celebrations')).toHaveProp('accessibilityLabel', 'Unlocked: Level 5!, First Drive');
});

describe('Report', () => {
  const open = async (e = event()) => {
    const p = props({ events: [e] });
    await draw(<SummaryView {...p} />);
    await press(screen.getByTestId('breakdown-toggle'));
    await press(screen.getByTestId(`report-${e.id}`));
    return p;
  };

  test('a hard brake offers "braked for a hazard" and "wasn\'t driving" only', async () => {
    await open();
    expect(screen.getByTestId('reason-hazard')).toBeOnTheScreen();
    expect(screen.getByTestId('reason-not_driving')).toBeOnTheScreen();
    expect(screen.queryByTestId('reason-wrong_limit')).toBeNull();
    expect(screen.queryByTestId('reason-mounted')).toBeNull();
  });

  test('speeding offers "wrong speed limit"; a phone pickup offers "phone was mounted"', async () => {
    await open(event({ id: 's1', type: 'speeding', tier: 'moderate' }));
    expect(screen.getByTestId('reason-wrong_limit')).toBeOnTheScreen();
    expect(screen.queryByTestId('reason-hazard')).toBeNull();
  });

  test('a phone pickup offers "phone was mounted"', async () => {
    await open(event({ id: 'p1', type: 'phone_pickup', tier: 'severe' }));
    expect(screen.getByTestId('reason-mounted')).toBeOnTheScreen();
  });

  test('sending a reason reports the event', async () => {
    const p = await open();
    expect(screen.getByTestId('report-send')).toBeDisabled();
    await press(screen.getByTestId('reason-hazard'));
    await press(screen.getByTestId('report-send'));
    expect(p.onReport).toHaveBeenCalledWith('e1', 'hazard');
    expect(await screen.findByTestId('report-sent')).toBeOnTheScreen();
  });

  test('"wasn\'t driving" hands over to the whole-drive confirm', async () => {
    const p = await open();
    await press(screen.getByTestId('reason-not_driving'));
    await press(screen.getByTestId('report-send'));
    expect(p.onReport).not.toHaveBeenCalled();
    expect(screen.getByTestId('not-driving-sheet')).toBeOnTheScreen();
  });

  test('an event already reported shows its status instead of the link', async () => {
    await draw(<SummaryView {...props({ events: [event({ disputeStatus: 'pending' })] })} />);
    await press(screen.getByTestId('breakdown-toggle'));
    expect(screen.queryByTestId('report-e1')).toBeNull();
    expect(screen.getByTestId('dispute-e1')).toHaveTextContent(/Report sent/);
  });
});

describe("Wasn't driving", () => {
  test('the footer shows how many uses are left and the confirm repeats it', async () => {
    const p = props({ notDrivingLeft: 1 });
    await draw(<SummaryView {...p} />);
    expect(screen.getByTestId('not-driving')).toHaveTextContent("Wasn't driving (1 left this month)");
    await press(screen.getByTestId('not-driving'));
    expect(screen.getByTestId('not-driving-left')).toHaveTextContent(/You have 1 left\./);
    expect(screen.getByText(/The 167 points from this drive come off/)).toBeOnTheScreen();
    await press(screen.getByTestId('not-driving-confirm'));
    expect(p.onNotDriving).toHaveBeenCalled();
  });

  test('with none left the button is off', async () => {
    await draw(<SummaryView {...props({ notDrivingLeft: 0 })} />);
    expect(screen.getByTestId('not-driving')).toBeDisabled();
  });

  test('a drive already marked has no footer option', async () => {
    await draw(<SummaryView {...props({ drive: drive({ status: 'not_driving', pointsNet: 0 }) })} />);
    expect(screen.getByText('Marked as not driving')).toBeOnTheScreen();
    expect(screen.queryByTestId('not-driving')).toBeNull();
  });
});

test('Share previews the card without any speed and shares the image', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharing = require('expo-sharing') as { shareAsync: jest.Mock };
  await draw(<SummaryView {...props()} />);
  await press(screen.getByTestId('share'));
  const card = screen.getByTestId('share-card');
  expect(within(card).getByTestId('share-points')).toHaveTextContent('+167');
  expect(within(card).queryByText(/mph/)).toBeNull();
  await press(screen.getByTestId('share-image'));
  expect(sharing.shareAsync).toHaveBeenCalledWith('file:///card.png', expect.objectContaining({ mimeType: 'image/png' }));
});

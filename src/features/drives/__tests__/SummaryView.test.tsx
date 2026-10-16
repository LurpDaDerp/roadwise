import { screen, within } from '@testing-library/react-native';

import { publishUnits, resetUnitsForTests } from '@/data/queries/units';
import { tokens } from '@/ui/tokens';

import { DAY, draw, drive, event, NOW, press, result } from '../__fixtures__/drives';
import { SummaryView, type SummaryViewProps } from '../SummaryView';
import { endNote } from '../summary';

jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => true), shareAsync: jest.fn(async () => undefined) }));
jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn(async () => 'file:///card.png') }));

const props = (over: Partial<SummaryViewProps> = {}): SummaryViewProps => ({
  drive: drive(),
  events: [event()],
  fresh: false,
  notDrivingLeft: 2,
  safetyRating: 92,
  latestClientTripId: 'a1',
  now: NOW,
  onBack: jest.fn(),
  onOpenDrive: jest.fn(),
  onReport: jest.fn(async () => undefined),
  onNotDriving: jest.fn(async () => undefined),
  ...over,
});

test('the breakdown is collapsed by default and expands in place', async () => {
  await draw(<SummaryView {...props()} />);
  expect(screen.getByLabelText('Points earned: +132 points')).toBeOnTheScreen();
  const toggle = screen.getByTestId('breakdown-toggle');
  expect(toggle).toBeCollapsed();
  expect(screen.queryByTestId('breakdown')).toBeNull();

  await press(toggle);
  expect(screen.getByTestId('breakdown-toggle')).toBeExpanded();
  const list = screen.getByTestId('breakdown');
  expect(within(list).getByText('Safe miles: 11.8 mi × 10')).toBeOnTheScreen();
  expect(within(list).getByText('Multiplier: streak ×1.20')).toBeOnTheScreen();
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

describe('DashPal', () => {
  const dashpalResult = () => {
    const r = result();
    return { ...r, breakdown: { ...r.breakdown, dashcamMult: 1.25 as const, mult: 1.5, gains: 177, net: 167 }, net: 167 };
  };
  const drowsy = event({ id: 'd1', type: 'drowsy', tier: 'severe', penalty: 50, measured: { source: 'dashcam', speedMph: 40 } });

  test('a DashPal drive names both multipliers and shows the DashPal tile', async () => {
    await draw(<SummaryView {...props({ drive: drive({ pointsNet: 167, result: dashpalResult() }) })} />);
    expect(screen.getByTestId('counter-dashpal')).toHaveProp('accessibilityLabel', 'DashPal events: 0, none');
    await press(screen.getByTestId('breakdown-toggle'));
    expect(within(screen.getByTestId('breakdown')).getByText('Multiplier: streak ×1.20 · DashPal ×1.25 → ×1.50 (cap)')).toBeOnTheScreen();
  });

  test('a DashPal event is itemised and counted on the DashPal tile', async () => {
    const counts = { speeding: 0, pickups: 0, handlingS: 0, hardBrake: 1, hardAccel: 0, hardCorner: 0, eyesOff: 0, drowsy: 1 };
    await draw(<SummaryView {...props({ drive: drive({ counts }), events: [event(), drowsy] })} />);
    expect(screen.getByTestId('counter-dashpal')).toHaveProp('accessibilityLabel', 'DashPal events: 1');
    await press(screen.getByTestId('breakdown-toggle'));
    expect(within(screen.getByTestId('breakdown')).getByText('Drowsy · DashPal')).toBeOnTheScreen();
  });

  test('a drive without DashPal has no DashPal tile', async () => {
    await draw(<SummaryView {...props()} />);
    expect(screen.queryByTestId('counter-dashpal')).toBeNull();
  });

  test('a DashPal event offers "DashPal got it wrong" and "wasn\'t driving", and reports camera_wrong', async () => {
    const p = props({ events: [drowsy] });
    await draw(<SummaryView {...p} />);
    await press(screen.getByTestId('breakdown-toggle'));
    await press(screen.getByTestId('report-d1'));
    expect(screen.getByTestId('reason-camera_wrong')).toBeOnTheScreen();
    expect(screen.getByTestId('reason-not_driving')).toBeOnTheScreen();
    expect(screen.queryByTestId('reason-hazard')).toBeNull();
    expect(screen.getByText('DashPal got it wrong')).toBeOnTheScreen();
    await press(screen.getByTestId('reason-camera_wrong'));
    await press(screen.getByTestId('report-send'));
    expect(p.onReport).toHaveBeenCalledWith('d1', 'camera_wrong');
  });
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
    expect(screen.getByText(/The 132 points from this drive come off/)).toBeOnTheScreen();
    await press(screen.getByTestId('not-driving-confirm'));
    expect(p.onNotDriving).toHaveBeenCalled();
  });

  test('with none left the button is off', async () => {
    await draw(<SummaryView {...props({ notDrivingLeft: 0 })} />);
    expect(screen.getByTestId('not-driving')).toBeDisabled();
  });

  test('offered only on the latest drive, within 24 h', async () => {
    await draw(<SummaryView {...props({ latestClientTripId: 'newer' })} />);
    expect(screen.queryByTestId('not-driving')).toBeNull();
    await draw(<SummaryView {...props({ now: NOW + DAY })} />);
    expect(screen.queryByTestId('not-driving')).toBeNull();
  });

  test("where it is not offered, Report leaves out \"I wasn't driving\"", async () => {
    await draw(<SummaryView {...props({ latestClientTripId: 'newer' })} />);
    await press(screen.getByTestId('breakdown-toggle'));
    await press(screen.getByTestId('report-e1'));
    expect(screen.getByTestId('reason-hazard')).toBeOnTheScreen();
    expect(screen.queryByTestId('reason-not_driving')).toBeNull();
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
  expect(within(card).getByTestId('share-points')).toHaveTextContent('+132');
  expect(within(card).queryByText(/mph/)).toBeNull();
  // A fixed-size image: its text never follows Dynamic Type.
  expect(within(card).getByTestId('share-points')).toHaveProp('allowFontScaling', false);
  expect(within(card).getByTestId('share-points')).toHaveStyle({ fontSize: 28 });
  await press(screen.getByTestId('share-image'));
  expect(sharing.shareAsync).toHaveBeenCalledWith('file:///card.png', expect.objectContaining({ mimeType: 'image/png' }));
});

describe('final-review fixes', () => {
  afterEach(() => resetUnitsForTests());

  test("a refused \"Wasn't driving\" says why and is not offered again", async () => {
    await draw(<SummaryView {...props({ drive: drive({ syncError: 'too_old' }) })} />);
    expect(screen.getByTestId('not-driving-refused')).toHaveTextContent(/more than 24 hours old/);
    expect(screen.queryByTestId('not-driving')).toBeNull();
    await draw(<SummaryView {...props({ drive: drive({ syncError: 'no_uses_left' }) })} />);
    expect(screen.getByTestId('not-driving-refused')).toHaveTextContent(/both “Wasn’t driving” marks this month/);
  });

  test('an upload error is not mistaken for a refusal', async () => {
    await draw(<SummaryView {...props({ drive: drive({ syncError: 'invalid_payload' }) })} />);
    expect(screen.queryByTestId('not-driving-refused')).toBeNull();
    expect(screen.getByTestId('not-driving')).toBeOnTheScreen();
  });

  test('a pending drive the phone knows is too short says so straight away', async () => {
    await draw(<SummaryView {...props({ drive: drive({ status: 'pending', pointsNet: null, reason: 'too_short', result: null }) })} />);
    expect(screen.getByTestId('state-too-short')).toBeOnTheScreen();
  });

  test('the share card shows a whole-number rating, or "Unranked"', async () => {
    await draw(<SummaryView {...props()} />);
    await press(screen.getByTestId('share'));
    expect(screen.getByTestId('share-rating')).toHaveTextContent('92');
    const unranked = drive({ result: result({ progress: { points: 10, lifetime: 10, level: 1, levelUp: false, safetyRating: 88.2, ranked: false } }) });
    await draw(<SummaryView {...props({ drive: unranked })} />);
    await press(screen.getByTestId('share'));
    expect(screen.getByTestId('share-rating')).toHaveTextContent('Unranked');
  });

  test('km: the distance, the share card and the too-short note convert', async () => {
    publishUnits('km');
    await draw(<SummaryView {...props()} />);
    expect(screen.getByText('19.3 km')).toBeOnTheScreen();
    await press(screen.getByTestId('share'));
    expect(within(screen.getByTestId('share-card')).getByText('19.3 km')).toBeOnTheScreen();
    await draw(<SummaryView {...props({ drive: drive({ status: 'unscored', reason: 'too_short', pointsNet: null, result: null }) })} />);
    expect(screen.getByText(/Drives under 0.8 km/)).toBeOnTheScreen();
  });
});

describe('the end note (this phone only)', () => {
  test.each([
    ['stopped', 'Ended on its own after 15 min without moving'],
    ['walking', 'Ended on its own when you walked away'],
    ['limit', 'Ended on its own at the 12-hour limit'],
    ['manual_still', 'Ends where the car stopped; phone use before End still counts'],
  ] as const)('a drive ended %s says so under the title, and in the header label', async (endCause, line) => {
    expect(endNote({ endCause })).toBe(line);
    await draw(<SummaryView {...props({ drive: drive({ endCause }) })} />);
    expect(screen.getByTestId('summary-end-note')).toHaveTextContent(line);
    expect(screen.getByRole('header', { name: new RegExp(`${line.slice(0, 20)}`) })).toBeOnTheScreen();
  });

  test.each(['manual', 'orphan', null] as const)('none for %s (a hold at the tap, a drive left open, a drive from the server)', async (endCause) => {
    expect(endNote({ endCause })).toBeNull();
    await draw(<SummaryView {...props({ drive: drive({ endCause }) })} />);
    expect(screen.queryByTestId('summary-end-note')).toBeNull();
  });
});

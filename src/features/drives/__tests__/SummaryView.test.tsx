import { screen, within } from '@testing-library/react-native';
import { driveMerit } from '@scoring';

import { publishUnits, resetUnitsForTests } from '@/data/queries/units';
import { contrastRatio, SHEET_DISMISS_FALLBACK_MS } from '@/ui';
import { opaque, over } from '@/ui/sky/color';
import { plainBundle } from '@/ui/sky/palette';

import { DAY, draw, drive, event, HOUR, NOW, press } from '../__fixtures__/drives';
import { meritInk, meritWash } from '../merit';
import { SummaryView, type SummaryViewProps } from '../SummaryView';

jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => true), shareAsync: jest.fn(async () => undefined) }));
jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn(async () => 'file:///card.png') }));

// Dynamic Type at the phone's default (jest's own window says 2×).
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 750, height: 1334, scale: 2, fontScale: 1 }),
}));

const NO_POINTS = /\bpoints?\b|\bpts\b|streak|freeze|\blevel\b|Estimate|Scoring/i;

const props = (over: Partial<SummaryViewProps> = {}): SummaryViewProps => ({
  drive: drive(),
  events: [event()],
  fresh: false,
  notDrivingLeft: 2,
  now: NOW,
  onBack: jest.fn(),
  onOpenDrive: jest.fn(),
  onReport: jest.fn(async () => undefined),
  onNotDriving: jest.fn(async () => undefined),
  ...over,
});

/** Every testID on screen, in render order. */
function testIds(): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    const node = n as { props?: { testID?: string }; children?: unknown };
    if (node.props?.testID) out.push(node.props.testID);
    walk(node.children);
  };
  walk(screen.toJSON());
  return out;
}

const light = plainBundle('light').colors;

test('top to bottom: time and distance, the route map, then the hero with Share beside it, then the events', async () => {
  await draw(<SummaryView {...props()} />);
  const ids = testIds();
  const at = (id: string) => ids.indexOf(id);
  expect(at('summary-trip')).toBeGreaterThan(-1);
  expect(at('summary-trip')).toBeLessThan(at('route-map'));
  expect(at('route-map')).toBeLessThan(at('summary-score-card'));
  expect(at('summary-hero')).toBeLessThan(at('summary-facts'));
  expect(at('summary-facts')).toBeLessThan(at('share'));
  expect(at('share')).toBeLessThan(at('event-list'));
  // Share sits in the hero's own row, right beside the facts.
  expect(within(screen.getByTestId('summary-hero')).getByTestId('share')).toBeOnTheScreen();
  const trip = screen.getByTestId('summary-trip');
  expect(within(trip).getByText('24 min · 12.0 mi')).toBeOnTheScreen();
  expect(within(trip).getByText(/^Mon, Oct 5 · /)).toBeOnTheScreen();
  expect(trip).toHaveProp('accessibilityLabel', expect.stringMatching(/^24 minutes, 12\.0 miles\. Mon, Oct 5, /));
  expect(JSON.stringify(screen.toJSON())).not.toMatch(NO_POINTS);
});

describe('the hero mirrors the share card', () => {
  test('the tier icon beside the score, then distance and time, labelled, all three in the tier ink on its wash', async () => {
    await draw(<SummaryView {...props()} />);
    // 12 mi with one minor hard brake in 30 slowdowns: Braking 63, the rest 100, Speed counting double.
    expect(screen.getByTestId('summary-facts-score')).toHaveTextContent('93');
    const tier = driveMerit(93, 12)!;
    expect(tier).toBe(4);
    const wash = meritWash(tier, 'light');
    const surfaces = [light.surface, over(opaque(light.surface), wash)];
    const ink = meritInk(tier, surfaces);
    for (const id of ['summary-facts-score', 'summary-facts-distance', 'summary-facts-time']) expect(screen.getByTestId(id)).toHaveStyle({ color: ink });
    expect(screen.getByTestId('summary-facts-icon', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByTestId('summary-hero')).toHaveStyle({ backgroundColor: wash });
    for (const s of surfaces) expect(contrastRatio(ink, opaque(s))).toBeGreaterThanOrEqual(4.5);
    expect(within(screen.getByTestId('summary-facts')).getByText('score')).toBeOnTheScreen();
    expect(within(screen.getByTestId('summary-facts')).getByText('distance')).toBeOnTheScreen();
    expect(within(screen.getByTestId('summary-facts')).getByText('time')).toBeOnTheScreen();
    expect(screen.getByTestId('summary-facts')).toHaveProp('accessibilityLabel', 'Score 93 out of 100, 12.0 miles, 24 minutes, merit 4 of 5.');
  });

  test('the hero uses the share card type at 0.8×', async () => {
    await draw(<SummaryView {...props()} />);
    expect(screen.getByTestId('summary-facts-score')).toHaveStyle({ fontSize: 44 * 0.8 });
    expect(screen.getByTestId('summary-facts-distance')).toHaveStyle({ fontSize: 28 * 0.8 });
  });

  test('a short perfect drive stays at the lowest tier; a long excellent one is high', async () => {
    await draw(<SummaryView {...props({ drive: drive({ miles: 0.6 }), events: [] })} />);
    expect(screen.getByTestId('summary-facts-score')).toHaveTextContent('100');
    expect(screen.getByTestId('summary-facts')).toHaveProp('accessibilityLabel', expect.stringMatching(/merit 1 of 5\.$/));
    await draw(<SummaryView {...props({ drive: drive({ miles: 26 }), events: [] })} />);
    expect(screen.getByTestId('summary-facts')).toHaveProp('accessibilityLabel', expect.stringMatching(/merit 5 of 5\.$/));
  });

  test('the score never waits for the server: an uploading drive and one not synced yet show theirs', async () => {
    await draw(<SummaryView {...props({ drive: drive({ status: 'pending', result: null }) })} />);
    expect(screen.getByTestId('summary-facts-score')).toHaveTextContent('93');
    expect(screen.queryByTestId('state-not-synced')).toBeNull();
    await draw(<SummaryView {...props({ drive: drive({ status: 'failed', result: null }) })} />);
    expect(screen.getByTestId('summary-facts-score')).toHaveTextContent('93');
    expect(screen.getByTestId('state-not-synced')).toHaveTextContent("Not synced yet. We'll keep trying.");
  });

  test.each([
    [{ status: 'recording', result: null }, 'state-recording', 'Drive in progress', 'Your score shows up when the drive ends.'],
    [{ status: 'unscored', reason: 'too_short', result: null }, 'state-too-short', 'Too short to score', "Drives under 0.5 mi that take under 2 min don't get a score."],
    [{ status: 'pending', reason: 'too_short', result: null }, 'state-too-short', 'Too short to score', "Drives under 0.5 mi that take under 2 min don't get a score."],
    [{ status: 'not_driving' }, 'state-not-driving', 'Marked as not driving', "This drive doesn't count toward your Safety Rating."],
    [{ status: 'merged', mergedInto: 'z' }, 'state-merged-text', 'Added to your last drive', 'You set off again within 5 minutes, so the two count as one drive.'],
  ] as const)('%o: the state instead of a score, Share still beside it', async (over, id, title, body) => {
    await draw(<SummaryView {...props({ drive: drive(over as never) })} />);
    expect(screen.getByTestId(id)).toHaveTextContent(title, { exact: false });
    expect(screen.getByText(body)).toBeOnTheScreen();
    expect(screen.queryByTestId('summary-facts')).toBeNull();
    expect(screen.getByTestId('share')).toBeOnTheScreen();
  });

  test('a merged drive opens the one it joined', async () => {
    const p = props({ drive: drive({ status: 'merged', mergedInto: 'z' }) });
    await draw(<SummaryView {...p} />);
    await press(screen.getByText('Open that drive'));
    expect(p.onOpenDrive).toHaveBeenCalledWith('z');
  });

  test('Share opens the card with the same score, tier ink and facts', async () => {
    await draw(<SummaryView {...props()} />);
    await press(screen.getByTestId('share'));
    const card = screen.getByTestId('share-card');
    expect(within(card).getByTestId('share-facts-score')).toHaveTextContent('93');
    expect(within(card).getByTestId('share-facts')).toHaveProp('accessibilityLabel', 'Score 93 out of 100, 12.0 miles, 24 minutes, merit 4 of 5.');
    expect(within(card).queryByText(/mph/)).toBeNull();
  });
});

describe('the events', () => {
  test('one row per event, oldest first, its icon in its tier ink, its name and time, Report under it', async () => {
    const events = [
      event({ id: 's1', type: 'speeding', tier: 'moderate', startedAt: NOW - 2 * HOUR + 20 * 60_000 }),
      event({ id: 'e1', startedAt: NOW - 2 * HOUR + 9 * 60_000 }),
    ];
    await draw(<SummaryView {...props({ events })} />);
    expect(screen.getByTestId('event-list-title')).toHaveTextContent('Events · 2');
    const ids = testIds();
    expect(ids.indexOf('event-e1')).toBeLessThan(ids.indexOf('event-s1'));
    expect(within(screen.getByTestId('event-e1')).getByText('Hard brake · Minor')).toBeOnTheScreen();
    expect(screen.getByTestId('event-s1')).toHaveProp('accessibilityHint', 'Circles it on the route map');
    expect(screen.getByTestId('report-e1')).toBeOnTheScreen();
  });

  test('a clean drive says so', async () => {
    await draw(<SummaryView {...props({ events: [] })} />);
    expect(screen.getByTestId('event-list-none')).toHaveTextContent('No events. Smooth all the way.');
    expect(screen.getByTestId('event-list-title')).toHaveTextContent('Events · 0');
  });

  test('three rows, then "Show more" reveals the rest and "Show less" hides them', async () => {
    const events = [0, 1, 2, 3, 4].map((i) => event({ id: `x${i}`, startedAt: NOW - 2 * HOUR + i * 60_000 }));
    await draw(<SummaryView {...props({ events })} />);
    expect(screen.queryByTestId('event-x3')).toBeNull();
    const more = screen.getByTestId('event-list-more');
    expect(more).toHaveProp('accessibilityHint', 'Shows 2 more events');
    await press(more);
    expect(screen.getByTestId('event-x4')).toBeOnTheScreen();
    await press(screen.getByText('Show less'));
    expect(screen.queryByTestId('event-x4')).toBeNull();
  });

  test('an event taken off by a report stays listed, struck through, with its status', async () => {
    await draw(<SummaryView {...props({ events: [event({ disputeStatus: 'accepted' })] })} />);
    const line = screen.getByTestId('event-e1');
    expect(line).toHaveProp('accessibilityLabel', expect.stringMatching(/, removed$/));
    expect(within(line).getByText('Hard brake · Minor')).toHaveStyle({ textDecorationLine: 'line-through' });
    expect(screen.getByTestId('dispute-e1')).toHaveTextContent('Report accepted · event removed');
    // a removed event costs nothing: the drive scores as clean
    expect(screen.getByTestId('summary-facts-score')).toHaveTextContent('100');
  });

  test('tapping an event selects it and circles it on the map', async () => {
    await draw(<SummaryView {...props()} />);
    expect(screen.queryByTestId('map-highlight-caption')).toBeNull();
    await press(screen.getByTestId('event-e1'));
    expect(screen.getByTestId('event-e1')).toBeSelected();
    expect(screen.getByTestId('map-highlight-caption')).toHaveTextContent(/^Circled on the map: Hard brake · Minor at /);
    await press(screen.getByTestId('event-e1'));
    expect(screen.queryByTestId('map-highlight-caption')).toBeNull();
  });

  test('an event outside the map (privacy zone) says so when tapped', async () => {
    await draw(<SummaryView {...props({ events: [event({ lat: null, lng: null })] })} />);
    await press(screen.getByTestId('event-e1'));
    expect(screen.getByTestId('map-highlight-caption')).toHaveTextContent(/isn't on the map/);
  });

  test('a too-short drive still lists its events; a drive in progress, merged or marked lists none', async () => {
    await draw(<SummaryView {...props({ drive: drive({ status: 'unscored', reason: 'too_short' }) })} />);
    expect(screen.getByTestId('event-e1')).toBeOnTheScreen();
    for (const over of [{ status: 'recording' }, { status: 'merged', mergedInto: 'z' }, { status: 'not_driving' }] as const) {
      await draw(<SummaryView {...props({ drive: drive(over) })} />);
      expect(screen.queryByTestId('event-list')).toBeNull();
    }
  });

  test('a DashPal event is listed in the muted ink and offers "DashPal got it wrong"', async () => {
    const drowsy = event({ id: 'd1', type: 'drowsy', tier: 'severe', measured: { source: 'dashcam', speedMph: 40 } });
    const p = props({ events: [drowsy] });
    await draw(<SummaryView {...p} />);
    expect(within(screen.getByTestId('event-d1')).getByText('Drowsy · DashPal')).toBeOnTheScreen();
    await press(screen.getByTestId('report-d1'));
    expect(screen.getByTestId('reason-camera_wrong')).toBeOnTheScreen();
    expect(screen.getByTestId('reason-not_driving')).toBeOnTheScreen();
    await press(screen.getByTestId('reason-camera_wrong'));
    await press(screen.getByTestId('report-send'));
    expect(p.onReport).toHaveBeenCalledWith('d1', 'camera_wrong');
  });

  test('a phone pickup is listed as "Phone pickup" with its time in hand and speed, spoken whole', async () => {
    const pickup = event({ id: 'p1', type: 'phone_pickup', tier: 'severe', durationS: 24, measured: { speedMph: 38.2, maxSpeedMph: 44 } });
    await draw(<SummaryView {...props({ events: [pickup] })} />);
    const row = screen.getByTestId('event-p1');
    expect(within(row).getByText('Phone pickup')).toBeOnTheScreen();
    expect(screen.getByTestId('event-detail-p1', { includeHiddenElements: true })).toHaveTextContent('In hand 24 s · 38 mph');
    expect(row.props.accessibilityLabel).toMatch(/^Phone pickup at .+, in hand 24 seconds, at 38 miles per hour$/);
  });

  test('in kilometres a pickup says its speed in km/h', async () => {
    publishUnits('km');
    try {
      const pickup = event({ id: 'p1', type: 'phone_pickup', tier: 'moderate', durationS: 9, measured: { speedMph: 30 } });
      await draw(<SummaryView {...props({ events: [pickup] })} />);
      expect(screen.getByTestId('event-detail-p1', { includeHiddenElements: true })).toHaveTextContent('In hand 9 s · 48 km/h');
    } finally {
      resetUnitsForTests();
    }
  });
});

describe('Report', () => {
  const open = async (e = event()) => {
    const p = props({ events: [e] });
    await draw(<SummaryView {...p} />);
    await press(screen.getByTestId(`report-${e.id}`));
    return p;
  };

  test('a hard brake offers "braked for a hazard" and "wasn\'t driving" only, never "my phone was mounted"', async () => {
    await open();
    expect(screen.getByTestId('reason-hazard')).toBeOnTheScreen();
    expect(screen.getByTestId('reason-not_driving')).toBeOnTheScreen();
    expect(screen.queryByTestId('reason-wrong_limit')).toBeNull();
    expect(screen.queryByTestId('reason-mounted')).toBeNull();
  });

  test('a phone pickup offers "my phone was mounted" and "wasn\'t driving", and sends "mounted"', async () => {
    const p = await open(event({ id: 'p1', type: 'phone_pickup', tier: 'moderate', durationS: 6 }));
    expect(screen.getByText('Phone pickup at 1:09 PM')).toBeOnTheScreen();
    expect(screen.getByTestId('reason-mounted')).toHaveAccessibleName('My phone was mounted');
    expect(screen.getByText("If your phone sat in a mount and a bump looked like a pickup, we'll take it off right away, up to 3 times a week.")).toBeOnTheScreen();
    expect(screen.getByTestId('reason-not_driving')).toBeOnTheScreen();
    expect(screen.queryByTestId('reason-hazard')).toBeNull();
    await press(screen.getByTestId('reason-mounted'));
    await press(screen.getByTestId('report-send'));
    expect(p.onReport).toHaveBeenCalledWith('p1', 'mounted');
  });

  test('speeding offers "wrong speed limit"', async () => {
    await open(event({ id: 's1', type: 'speeding', tier: 'moderate' }));
    expect(screen.getByTestId('reason-wrong_limit')).toBeOnTheScreen();
    expect(screen.queryByTestId('reason-hazard')).toBeNull();
  });

  test(`a sharp turn or hard start offers Report only while "wasn't driving" can be its reason`, async () => {
    const turn = event({ id: 't1', type: 'hard_corner', tier: 'moderate' });
    const start = event({ id: 'a1x', type: 'hard_accel', tier: 'minor' });
    const shows = async (over: Partial<SummaryViewProps>) => {
      const view = await draw(<SummaryView {...props(over)} />);
      const ids = ['t1', 'a1x', 'e1'].filter((id) => screen.queryByTestId(`report-${id}`) !== null);
      await view.unmount();
      return ids;
    };
    expect(await shows({ events: [turn, start] })).toEqual(['t1', 'a1x']);
    expect(await shows({ events: [turn, start], now: NOW + DAY })).toEqual([]);
    expect(await shows({ events: [turn, start], notDrivingLeft: 0 })).toEqual([]);
    expect(await shows({ events: [event()], now: NOW + DAY })).toEqual(['e1']);
  });

  test('sending a reason reports the event and thanks the driver', async () => {
    const p = await open();
    expect(screen.getByTestId('report-send')).toBeDisabled();
    await press(screen.getByTestId('reason-hazard'));
    await press(screen.getByTestId('report-send'));
    expect(p.onReport).toHaveBeenCalledWith('e1', 'hazard');
    expect(await screen.findByTestId('report-sent')).toHaveTextContent(/Thanks. We'll check it and update this drive./);
  });

  test('"wasn\'t driving" hands over to the whole-drive confirm', async () => {
    const p = await open();
    await press(screen.getByTestId('reason-not_driving'));
    await press(screen.getByTestId('report-send'));
    expect(p.onReport).not.toHaveBeenCalled();
    expect(screen.queryByTestId('not-driving-sheet')).toBeNull();
    expect(await screen.findByTestId('not-driving-sheet', {}, { timeout: SHEET_DISMISS_FALLBACK_MS + 1000 })).toBeOnTheScreen();
  });

  test('an event already reported shows its status instead of the link', async () => {
    await draw(<SummaryView {...props({ events: [event({ disputeStatus: 'pending' })] })} />);
    expect(screen.queryByTestId('report-e1')).toBeNull();
    expect(screen.getByTestId('dispute-e1')).toHaveTextContent(/Report sent/);
  });
});

describe("Wasn't driving", () => {
  test('the footer shows how many uses are left and the confirm repeats it, with no points or streak words', async () => {
    const p = props({ notDrivingLeft: 1 });
    await draw(<SummaryView {...p} />);
    expect(screen.getByTestId('not-driving')).toHaveTextContent("Wasn't driving (1 left this month)");
    await press(screen.getByTestId('not-driving'));
    expect(screen.getByTestId('not-driving-left')).toHaveTextContent(/You have 1 left\./);
    expect(screen.getByText("Use this if someone else was behind the wheel. This drive won't count toward your Safety Rating.")).toBeOnTheScreen();
    await press(screen.getByTestId('not-driving-confirm'));
    expect(p.onNotDriving).toHaveBeenCalled();
  });

  test('with none left it is not offered', async () => {
    await draw(<SummaryView {...props({ notDrivingLeft: 0 })} />);
    expect(screen.queryByTestId('not-driving')).toBeNull();
  });

  test('any drive within a day of its end, not only the latest; never after 24 h', async () => {
    const ended = NOW - 2 * HOUR + 24 * 60_000;
    await draw(<SummaryView {...props({ now: ended + DAY - 1 })} />);
    expect(screen.getByTestId('not-driving')).toBeOnTheScreen();
    await draw(<SummaryView {...props({ now: ended + DAY + 1 })} />);
    expect(screen.queryByTestId('not-driving')).toBeNull();
  });

  test('not when the drive\'s "Not driving?" ran out during it', async () => {
    await draw(<SummaryView {...props({ drive: drive({ notDrivingExpired: true }) })} />);
    expect(screen.queryByTestId('not-driving')).toBeNull();
    await press(screen.getByTestId('report-e1'));
    expect(screen.queryByTestId('reason-not_driving')).toBeNull();
  });

  test('a drive already marked has no footer option', async () => {
    await draw(<SummaryView {...props({ drive: drive({ status: 'not_driving' }) })} />);
    expect(screen.queryByTestId('not-driving')).toBeNull();
  });

  test.each([
    ['too_old', 'This drive is more than a day old, so it can’t be marked.'],
    ['no_uses_left', 'You’ve used both “Wasn’t driving” marks this month.'],
    ['not_driving_expired', 'The “Not driving?” option on that drive ran out, so it can’t be marked.'],
  ])('a refusal (%s) says why and is not offered again', async (code, line) => {
    await draw(<SummaryView {...props({ drive: drive({ syncError: code }) })} />);
    expect(screen.getByTestId('not-driving-refused')).toHaveTextContent(line);
    expect(screen.queryByTestId('not-driving')).toBeNull();
  });

  test('an upload error is not mistaken for a refusal', async () => {
    await draw(<SummaryView {...props({ drive: drive({ syncError: 'invalid_payload' }) })} />);
    expect(screen.queryByTestId('not-driving-refused')).toBeNull();
    expect(screen.getByTestId('not-driving')).toBeOnTheScreen();
  });
});

describe('units', () => {
  afterEach(() => resetUnitsForTests());

  test('km: the distance, the hero, the share card and the too-short note convert', async () => {
    publishUnits('km');
    await draw(<SummaryView {...props()} />);
    expect(within(screen.getByTestId('summary-trip')).getByText('24 min · 19.3 km')).toBeOnTheScreen();
    expect(screen.getByTestId('summary-facts-distance')).toHaveTextContent('19.3 km');
    await press(screen.getByTestId('share'));
    expect(within(screen.getByTestId('share-card')).getByText('19.3 km')).toBeOnTheScreen();
    await draw(<SummaryView {...props({ drive: drive({ status: 'unscored', reason: 'too_short', result: null }) })} />);
    expect(screen.getByText("Drives under 0.8 km that take under 2 min don't get a score.")).toBeOnTheScreen();
  });
});

describe('how the drive started and ended', () => {
  test.each(['stopped', 'walking', 'limit', 'manual_still', 'manual', 'orphan', null] as const)('a drive ended %s says nothing about how it started or ended', async (endCause) => {
    await draw(<SummaryView {...props({ drive: drive({ origin: 'auto', endCause }) })} />);
    expect(screen.queryByText(/Started on its own|Ended |Ends where|walked away/)).toBeNull();
  });
});

import { screen, within } from '@testing-library/react-native';

import { publishUnits, resetUnitsForTests } from '@/data/queries/units';
import { fontFamilies, SHEET_DISMISS_FALLBACK_MS } from '@/ui';
import { plainBundle } from '@/ui/sky/palette';

import { DAY, draw, drive, event, HOUR, NOW, press, result } from '../__fixtures__/drives';
import { scoreInk } from '../scoreInk';
import { SummaryView, type SummaryViewProps } from '../SummaryView';
import { endNote } from '../summary';

jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => true), shareAsync: jest.fn(async () => undefined) }));
jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn(async () => 'file:///card.png') }));

const props = (over: Partial<SummaryViewProps> = {}): SummaryViewProps => ({
  drive: drive(),
  events: [event()],
  fresh: false,
  notDrivingLeft: 2,
  latestClientTripId: 'a1',
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

test('top to bottom: time and distance, the route map, then the points', async () => {
  await draw(<SummaryView {...props()} />);
  const ids = testIds();
  const at = (id: string) => ids.indexOf(id);
  expect(at('summary-trip')).toBeGreaterThan(-1);
  expect(at('summary-trip')).toBeLessThan(at('route-map'));
  expect(at('route-map')).toBeLessThan(at('summary-points-card'));
  expect(at('summary-points')).toBeLessThan(at('receipt'));
  const trip = screen.getByTestId('summary-trip');
  expect(within(trip).getByText('24 min · 12.0 mi')).toBeOnTheScreen();
  expect(within(trip).getByText(/^Mon, Oct 5 · /)).toBeOnTheScreen();
  expect(trip).toHaveProp('accessibilityLabel', expect.stringMatching(/^24 minutes, 12\.0 miles\. Mon, Oct 5, /));
});

test('the summary drops the streak line, the stats row, the route labels and the unlocked row', async () => {
  const r = result({ achievements: ['first_drive'], progress: { ...result().progress, levelUp: true, level: 5 } });
  await draw(<SummaryView {...props({ drive: drive({ result: r, clean: true }) })} />);
  expect(screen.queryByText(/Streak 11/)).toBeNull();
  expect(screen.queryByTestId('streak-line')).toBeNull();
  expect(screen.queryByTestId('celebrations')).toBeNull();
  expect(screen.queryByTestId('counter-hardBrake')).toBeNull();
  expect(screen.queryByText('Distance')).toBeNull();
  expect(screen.queryByText(/Home → School/)).toBeNull();
  expect(screen.queryByTestId('clean-badge')).toBeNull();
  expect(screen.queryByTestId('receipt-total')).toBeNull();
});

test('the total is in bold above the breakdown', async () => {
  await draw(<SummaryView {...props()} />);
  const total = screen.getByTestId('summary-points');
  expect(total).toHaveProp('accessibilityLabel', 'Points this drive: +132 points');
  expect(within(total).getByText('+132')).toHaveStyle({ fontFamily: fontFamilies.displayItalic }); // the 800 ExtraBold face
});

describe('the drive score', () => {
  test('top right of the points card, beside the total: the number in its ink, "score" under it, spoken out of 100', async () => {
    await draw(<SummaryView {...props()} />);
    const ids = testIds();
    expect(ids.indexOf('summary-points-card')).toBeLessThan(ids.indexOf('summary-score'));
    expect(ids.indexOf('summary-points')).toBeLessThan(ids.indexOf('summary-score'));
    expect(ids.indexOf('summary-score')).toBeLessThan(ids.indexOf('receipt'));
    const score = screen.getByTestId('summary-score');
    expect(score).toHaveProp('accessibilityLabel', 'Drive score 99 out of 100');
    expect(score).toHaveProp('accessible', true);
    expect(within(score).getByText('score')).toBeOnTheScreen();
    const c = plainBundle('light').colors;
    expect(screen.getByTestId('summary-score-value')).toHaveTextContent('99');
    expect(screen.getByTestId('summary-score-value')).toHaveStyle({ color: scoreInk(99, c, c.surface) });
  });

  test('a rough drive is coloured further toward red', async () => {
    const pickups = [event({ id: 'p1', type: 'phone_pickup', tier: 'severe' }), event({ id: 'p2', type: 'phone_pickup', tier: 'severe' })];
    await draw(<SummaryView {...props({ drive: drive({ miles: 2 }), events: pickups })} />);
    // 80 rating penalty over 3 mi (the floor): phone 37.5, counted twice → 82.
    expect(screen.getByTestId('summary-score')).toHaveProp('accessibilityLabel', 'Drive score 82 out of 100');
    const c = plainBundle('light').colors;
    expect(screen.getByTestId('summary-score-value')).toHaveStyle({ color: scoreInk(82, c, c.surface) });
  });

  test('an estimate and a drive not synced yet with a total show it; no total, no score', async () => {
    await draw(<SummaryView {...props({ drive: drive({ status: 'pending', estimate: true, pointsNet: 40, result: null }) })} />);
    expect(screen.getByTestId('summary-score')).toBeOnTheScreen();
    await draw(<SummaryView {...props({ drive: drive({ status: 'failed', pointsNet: 40, result: null }) })} />);
    expect(screen.getByTestId('summary-score')).toBeOnTheScreen();
    for (const d of [
      drive({ status: 'failed', pointsNet: null, result: null }),
      drive({ status: 'pending', pointsNet: null, result: null }),
      drive({ status: 'unscored', reason: 'too_short', pointsNet: 0, result: null }),
      drive({ status: 'unscored', reason: 'spoofed', pointsNet: null, result: null }),
      drive({ status: 'not_driving', pointsNet: 0 }),
      drive({ status: 'merged', mergedInto: 'z' }),
      drive({ status: 'recording', pointsNet: null, result: null }),
    ]) {
      await draw(<SummaryView {...props({ drive: d })} />);
      expect(screen.queryByTestId('summary-score')).toBeNull();
    }
  });
});

test('the receipt lists what was earned and each deduction, open from the start', async () => {
  await draw(<SummaryView {...props()} />);
  expect(screen.getByLabelText('Points this drive: +132 points')).toBeOnTheScreen();
  expect(screen.queryByTestId('breakdown-toggle')).toBeNull();
  const r = screen.getByTestId('receipt');

  const earned = within(r).getByTestId('receipt-earned');
  expect(earned).toHaveProp('accessibilityLabel', 'Earned, plus 142 points. Safe miles 11.8 mi × 10, Streak ×1.20');
  expect(within(earned).getByText('+142')).toHaveStyle({ color: plainBundle('light').colors.signal.clean.text });
  expect(within(earned).getByText('Earned')).toBeOnTheScreen();
  expect(within(r).getByTestId('receipt-detail')).toHaveTextContent('Safe miles 11.8 mi × 10 · Streak ×1.20');

  const line = within(r).getByTestId('event-e1');
  expect(line).toHaveProp('accessibilityLabel', expect.stringMatching(/^Hard brake · Minor at .+, minus 10 points$/));
  expect(within(line).getByText('−10')).toHaveStyle({ color: plainBundle('light').colors.signal.severe.text });
  expect(within(r).queryByTestId('receipt-none')).toBeNull();
});

test('a clean drive says "No deductions" and keeps the clean bonus in the detail', async () => {
  const base = result();
  const r = result({ breakdown: { ...base.breakdown, cleanBonus: 25, gains: 172, events: [], penalties: 0, net: 172 }, net: 172 });
  const counts = { speeding: 0, pickups: 0, handlingS: 0, hardBrake: 0, hardAccel: 0, hardCorner: 0, eyesOff: 0, drowsy: 0 };
  await draw(<SummaryView {...props({ drive: drive({ pointsNet: 172, clean: true, counts, result: r }), events: [] })} />);
  expect(screen.getByTestId('receipt-none')).toHaveTextContent('No deductions');
  expect(screen.getByTestId('receipt-detail')).toHaveTextContent('Safe miles 11.8 mi × 10 · Clean bonus +25 · Streak ×1.20');
  expect(screen.getByTestId('summary-points')).toHaveProp('accessibilityLabel', 'Points this drive: +172 points');
});

test('a drive scored at 20 a safe mile says × 20 and shows its +50 clean bonus', async () => {
  const base = result();
  const r = result({ breakdown: { ...base.breakdown, pointsPerMile: 20, milePoints: 236, cleanBonus: 50, gains: 343, events: [], penalties: 0, net: 343 }, net: 343 });
  const counts = { speeding: 0, pickups: 0, handlingS: 0, hardBrake: 0, hardAccel: 0, hardCorner: 0, eyesOff: 0, drowsy: 0 };
  await draw(<SummaryView {...props({ drive: drive({ pointsNet: 343, clean: true, counts, result: r }), events: [] })} />);
  expect(screen.getByTestId('receipt-detail')).toHaveTextContent('Safe miles 11.8 mi × 20 · Clean bonus +50 · Streak ×1.20');
  expect(screen.getByTestId('receipt-earned')).toHaveProp('accessibilityLabel', 'Earned, plus 343 points. Safe miles 11.8 mi × 20, Clean bonus +50, Streak ×1.20');
});

test('a DashPal drive shows the multiplier arrow and says "to" aloud', async () => {
  const base = result();
  const r = result({ breakdown: { ...base.breakdown, dashcamMult: 1.25, mult: 1.5 } });
  await draw(<SummaryView {...props({ drive: drive({ result: r }) })} />);
  expect(screen.getByTestId('receipt-detail')).toHaveTextContent('Safe miles 11.8 mi × 10 · Streak ×1.20 · DashPal ×1.25 → ×1.50 (cap)');
  expect(screen.getByTestId('receipt-earned')).toHaveProp(
    'accessibilityLabel',
    expect.stringMatching(/Streak ×1\.20 · DashPal ×1\.25 to ×1\.50 \(cap\)$/)
  );
});

test('at most three entries show, Earned counting as one, then "Show more" reveals the rest', async () => {
  const many = Array.from({ length: 4 }, (_, i) => event({ id: `m${i}`, startedAt: NOW - 2 * HOUR + (i + 1) * 60_000 }));
  await draw(<SummaryView {...props({ events: many })} />);
  expect(screen.getByTestId('receipt-earned')).toBeOnTheScreen();
  expect(screen.getByTestId('event-m1')).toBeOnTheScreen();
  expect(screen.queryByTestId('event-m2')).toBeNull();
  const more = screen.getByTestId('receipt-more');
  expect(more).toHaveTextContent(/Show more/);
  expect(more).toHaveProp('accessibilityHint', 'Shows 2 more deductions');

  await press(more);
  expect(screen.getByTestId('event-m2')).toBeOnTheScreen();
  expect(screen.getByTestId('event-m3')).toBeOnTheScreen();
  expect(screen.getByTestId('receipt-more')).toHaveTextContent(/Show less/);

  await press(screen.getByTestId('receipt-more'));
  expect(screen.queryByTestId('event-m3')).toBeNull();
});

test('three entries need no "Show more": Earned and two deductions, or three deductions without Earned', async () => {
  await draw(<SummaryView {...props({ events: [event({ id: 'f0' }), event({ id: 'f1' })] })} />);
  expect(screen.getByTestId('event-f1')).toBeOnTheScreen();
  expect(screen.queryByTestId('receipt-more')).toBeNull();
  const three = Array.from({ length: 3 }, (_, i) => event({ id: `p${i}`, penalty: null }));
  await draw(<SummaryView {...props({ drive: drive({ status: 'pending', pointsNet: null, result: null }), events: three })} />);
  expect(screen.queryByTestId('receipt-earned')).toBeNull();
  expect(screen.getByTestId('event-p2')).toBeOnTheScreen();
  expect(screen.queryByTestId('receipt-more')).toBeNull();
});

test('an event taken off by a report stays on the receipt, struck through, as "Removed"', async () => {
  await draw(<SummaryView {...props({ events: [event({ disputeStatus: 'accepted' })] })} />);
  const line = screen.getByTestId('event-e1');
  expect(line).toHaveProp('accessibilityLabel', expect.stringMatching(/, removed$/));
  expect(within(line).getByText('Removed')).toHaveStyle({ color: plainBundle('light').colors.textMuted });
  expect(within(line).getByText('Hard brake · Minor')).toHaveStyle({ textDecorationLine: 'line-through' });
  expect(screen.getByTestId('dispute-e1')).toHaveTextContent('Report accepted · points returned');
});

test('tapping an event line selects it and circles it on the map', async () => {
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

test('without a maps module the route sketch fills the same square slot, with the events spoken', async () => {
  await draw(<SummaryView {...props()} />);
  const slot = screen.getByTestId('map-unavailable');
  expect(slot).toHaveStyle({ width: '100%', aspectRatio: 1 });
  expect(slot).toHaveProp('accessibilityLabel', 'Route map, 1 hard brake');
});

test('a negative drive shows red points with a true minus', async () => {
  const r = result({ net: -44 });
  await draw(<SummaryView {...props({ drive: drive({ pointsNet: -44, result: r }) })} />);
  const pts = screen.getByLabelText('Points this drive: −44 points');
  expect(pts).toBeOnTheScreen();
  expect(within(pts).getByText('−44')).toHaveStyle({ color: plainBundle('light').colors.signal.severe.text });
});

test('an offline estimate is labelled, earns the total plus its deductions, and explains the missing detail', async () => {
  await draw(<SummaryView {...props({ drive: drive({ status: 'pending', estimate: true, pointsNet: 40, result: null }) })} />);
  expect(screen.getByTestId('estimate')).toBeOnTheScreen();
  expect(screen.getByText('Estimate')).toBeOnTheScreen();
  expect(screen.getByTestId('receipt-earned')).toHaveProp('accessibilityLabel', 'Earned, plus 50 points');
  expect(screen.queryByTestId('receipt-detail')).toBeNull();
  expect(screen.getByTestId('summary-points')).toHaveProp('accessibilityLabel', 'Points this drive: +40 points');
  expect(screen.getByText('The full breakdown shows up once this drive is scored.')).toBeOnTheScreen();
});

test('a drive still uploading lists its events to report, without Earned or a total', async () => {
  await draw(<SummaryView {...props({ drive: drive({ status: 'pending', pointsNet: null, result: null }), events: [event({ penalty: null })] })} />);
  expect(screen.getByTestId('state-pending')).toBeOnTheScreen();
  expect(screen.queryByTestId('receipt-earned')).toBeNull();
  expect(screen.queryByTestId('summary-points')).toBeNull();
  expect(screen.getByTestId('event-e1')).toHaveProp('accessibilityLabel', expect.stringMatching(/points not known yet$/));
  expect(screen.getByTestId('report-e1')).toBeOnTheScreen();
});

test('a drive still uploading with no events shows no receipt', async () => {
  await draw(<SummaryView {...props({ drive: drive({ status: 'pending', pointsNet: null, result: null }), events: [] })} />);
  expect(screen.queryByTestId('receipt')).toBeNull();
});

test('a too-short drive says so instead of points', async () => {
  await draw(<SummaryView {...props({ drive: drive({ status: 'unscored', reason: 'too_short', pointsNet: 0, result: null }), events: [] })} />);
  expect(screen.getByText('Too short to score')).toBeOnTheScreen();
  expect(screen.getByText("Drives under 0.5 mi that take under 2 min don't earn or lose points.")).toBeOnTheScreen();
  expect(screen.queryByTestId('receipt')).toBeNull();
});

test('a drive that failed to upload says "Not synced yet" and keeps its total and receipt', async () => {
  await draw(<SummaryView {...props({ drive: drive({ status: 'failed', pointsNet: 40, result: null }) })} />);
  expect(screen.getByTestId('state-failed')).toHaveTextContent(/Not synced yet/);
  expect(screen.getByTestId('summary-points')).toHaveProp('accessibilityLabel', 'Points this drive: +40 points');
  expect(screen.getByTestId('event-e1')).toBeOnTheScreen();
});

describe('DashPal', () => {
  const dashpalResult = () => {
    const r = result();
    return { ...r, breakdown: { ...r.breakdown, dashcamMult: 1.25 as const, mult: 1.5, gains: 177, net: 167 }, net: 167 };
  };
  const drowsy = event({ id: 'd1', type: 'drowsy', tier: 'severe', penalty: 50, measured: { source: 'dashcam', speedMph: 40 } });

  test('a DashPal drive names both multipliers', async () => {
    await draw(<SummaryView {...props({ drive: drive({ pointsNet: 167, result: dashpalResult() }) })} />);
    expect(within(screen.getByTestId('receipt')).getByText(/Streak ×1.20 · DashPal ×1.25 → ×1.50 \(cap\)$/)).toBeOnTheScreen();
  });

  test('a DashPal event is itemised', async () => {
    await draw(<SummaryView {...props({ events: [event(), drowsy] })} />);
    expect(within(screen.getByTestId('receipt')).getByText('Drowsy · DashPal')).toBeOnTheScreen();
  });

  test('a DashPal event offers "DashPal got it wrong" and "wasn\'t driving", and reports camera_wrong', async () => {
    const p = props({ events: [drowsy] });
    await draw(<SummaryView {...p} />);
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

  test(`a sharp turn or hard start offers Report only while "wasn't driving" can be its reason`, async () => {
    const turn = event({ id: 't1', type: 'hard_corner', tier: 'moderate' });
    const start = event({ id: 'a1x', type: 'hard_accel', tier: 'minor' });
    const shows = async (over: Partial<SummaryViewProps>) => {
      const view = await draw(<SummaryView {...props(over)} />);
      const ids = ['t1', 'a1x', 'e1'].filter((id) => screen.queryByTestId(`report-${id}`) !== null);
      await view.unmount();
      return ids;
    };
    // The latest drive, within a day, with uses left: "wasn't driving" is the reason on offer.
    expect(await shows({ events: [turn, start] })).toEqual(['t1', 'a1x']);
    // An older drive, or none left this month: nothing fits, so no Report, never an empty sheet.
    expect(await shows({ events: [turn, start], latestClientTripId: 'other' })).toEqual([]);
    expect(await shows({ events: [turn, start], notDrivingLeft: 0 })).toEqual([]);
    // A hard brake on an older drive still has its own reason.
    expect(await shows({ events: [event()], latestClientTripId: 'other' })).toEqual(['e1']);
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
    // The confirm waits for the report sheet to leave: iOS shows one modal at a time.
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

  test('the share card shows the drive score in place of the Safety Rating, "—" when the drive has no total', async () => {
    // 12 mi with one minor hard brake scores 99, never the 30-day rating (92.4 in the result).
    await draw(<SummaryView {...props()} />);
    await press(screen.getByTestId('share'));
    const card = screen.getByTestId('share-card');
    expect(within(card).getByText('Drive score')).toBeOnTheScreen();
    expect(within(card).getByTestId('share-score')).toHaveTextContent('99');
    expect(within(card).getByTestId('share-score')).toHaveProp('allowFontScaling', false);
    expect(within(card).queryByText('Safety Rating')).toBeNull();
    expect(within(card).queryByTestId('share-rating')).toBeNull();
    // An offline estimate scores from the phone's own events.
    await draw(<SummaryView {...props({ drive: drive({ miles: 5, status: 'pending', estimate: true, pointsNet: 40, result: null }), events: [event({ type: 'phone_pickup', tier: 'severe' })] })} />);
    await press(screen.getByTestId('share'));
    expect(screen.getByTestId('share-score')).toHaveTextContent('90');
    for (const d of [
      drive({ status: 'pending', pointsNet: null, result: null }),
      drive({ status: 'unscored', reason: 'too_short', pointsNet: 0, result: null }),
      drive({ status: 'failed', pointsNet: 40, result: null }),
    ]) {
      await draw(<SummaryView {...props({ drive: d })} />);
      await press(screen.getByTestId('share'));
      expect(screen.getByTestId('share-points')).toHaveTextContent('—');
      expect(screen.getByTestId('share-score')).toHaveTextContent('—');
    }
  });

  test('km: the distance, the share card and the too-short note convert', async () => {
    publishUnits('km');
    await draw(<SummaryView {...props()} />);
    expect(within(screen.getByTestId('summary-trip')).getByText('24 min · 19.3 km')).toBeOnTheScreen();
    await press(screen.getByTestId('share'));
    expect(within(screen.getByTestId('share-card')).getByText('19.3 km')).toBeOnTheScreen();
    await draw(<SummaryView {...props({ drive: drive({ status: 'unscored', reason: 'too_short', pointsNet: null, result: null }) })} />);
    expect(screen.getByText("Drives under 0.8 km that take under 2 min don't earn or lose points.")).toBeOnTheScreen();
  });
});

describe('the end note (this phone only)', () => {
  test.each([
    ['stopped', 'Ended on its own after 15 min without moving'],
    ['walking', 'Ended on its own when you walked away'],
    ['limit', 'Ended on its own at the 12-hour limit'],
    ['manual_still', 'Ends where the car stopped. Phone use before End still counts'],
  ] as const)('a drive ended %s says so under the time and distance, and in the header label', async (endCause, line) => {
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

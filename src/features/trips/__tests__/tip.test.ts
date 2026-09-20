import { keepItUpTip } from '@/content/tips';
import {
  tipOutcomeOf,
  toTripEventView,
  toTripSummary,
  unscoredReasonOf,
  type TripDetail,
} from '@/data/queries';
import { deductions, eventRow, tripRow } from '@/data/queries/__fixtures__/rows';
import type { TripRow } from '@/data/db';

import { tipForTrip } from '@/features/trips/tip';

function detailOf(over: Partial<TripRow>, stage: TripDetail['stage'] = 'new'): TripDetail {
  const trip = toTripSummary(tripRow(over));
  return {
    trip,
    scoredTripCount: stage === 'new' ? 1 : 5,
    stage,
    tipOutcome: tipOutcomeOf(trip),
    unscoredReason: unscoredReasonOf(trip),
  };
}

const speeding = (id: string, over: Parameters<typeof eventRow>[0] = {}) =>
  toTripEventView(eventRow({ id, category: 'speeding', ...over }));

test('a locally provisional trip is coached: the picker sees it as final', () => {
  const detail = detailOf({
    status: 'provisional',
    category_deductions_json: JSON.stringify(deductions({ speeding: 6 })),
  });
  expect(tipForTrip(detail, [speeding('s1', { deduction: 6 })]).tip?.category).toBe('speeding');
});

test('a costly category is coached at the severity the drive actually paid for, in the driver stage', () => {
  const over = { category_deductions_json: JSON.stringify(deductions({ speeding: 6 })) };
  const low = speeding('s1', { severity: '1', deduction: 6 });
  const high = speeding('s2', {
    severity: '5',
    deduction: 6,
    measured_json: JSON.stringify({ overMps: 18, speedMps: 40, limitMps: 22 }),
  });

  expect(tipForTrip(detailOf(over), [low]).tip?.id).toBe('speeding-low-new');
  expect(tipForTrip(detailOf(over, 'experienced'), [low]).tip?.id).toBe('speeding-low-experienced');
  expect(tipForTrip(detailOf(over), [high]).tip?.id).toBe('speeding-high-new');
});

test('a possible event steers nothing: the low tip stands when only it was severe', () => {
  const over = { category_deductions_json: JSON.stringify(deductions({ speeding: 6 })) };
  const paid = speeding('s1', { severity: '1', deduction: 6 });
  const possible = speeding('p', {
    severity: '5',
    status: 'possible',
    deduction: 0,
    measured_json: JSON.stringify({ overMps: 18, speedMps: 40, limitMps: 22 }),
  });
  expect(tipForTrip(detailOf(over), [paid, possible]).tip?.id).toBe('speeding-low-new');
});

test('a clean drive earns the keep-it-up card, never a coaching tip', () => {
  expect(tipForTrip(detailOf({ score: 100 }), [])).toEqual({ outcome: 'keep_it_up', tip: keepItUpTip });
});

test('a trip without a score shows the facts and no tip at all', () => {
  expect(tipForTrip(detailOf({ score: null, status: 'unscored' }), [])).toEqual({
    outcome: 'facts_only',
    tip: null,
  });
});

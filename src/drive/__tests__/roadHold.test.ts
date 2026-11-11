import type { RoadStamp } from '@scoring';

import { nextRoadHold, NORMAL_ROAD, ROAD_EASE_MS, roadTightened, strictestRoad, type RoadHold } from '@/drive/roadHold';

/** The stamped state after each reading, one per second from 0. */
function run(reads: readonly (RoadStamp | null)[], from: RoadHold = NORMAL_ROAD): RoadStamp[] {
  let hold = from;
  return reads.map((read, i) => {
    hold = nextRoadHold(hold, read, i * 1000);
    return hold.road;
  });
}

/** `n` seconds of one reading. */
const secs = (n: number, read: RoadStamp | null): (RoadStamp | null)[] => Array.from({ length: n }, () => read);

const EASE_S = ROAD_EASE_MS / 1000;

test('a normal road stays normal: unknown and empty readings stamp nothing', () => {
  expect(run([null, {}, null, {}])).toEqual([{}, {}, {}, {}]);
  expect(roadTightened(NORMAL_ROAD.road)).toBe(false);
  expect(roadTightened({ g: 'wet' })).toBe(true);
  expect(roadTightened({ cap: 45 })).toBe(true);
  expect(roadTightened(null)).toBe(false);
});

test('a stricter reading tightens at once, grip and sight alike', () => {
  expect(run([{}, { g: 'wet' }, { g: 'ice' }, { g: 'ice', cap: 55 }, { g: 'ice', cap: 35 }])).toEqual([{}, { g: 'wet' }, { g: 'ice' }, { g: 'ice', cap: 55 }, { g: 'ice', cap: 35 }]);
});

test('an easier reading is taken up only after 5 minutes of it (row time)', () => {
  const out = run([{ g: 'water' }, ...secs(EASE_S + 1, {})]);
  // Rows 1 to 300 still read water; the row 300 s after the first easier one is normal.
  expect(out[EASE_S]).toEqual({ g: 'water' });
  expect(out[EASE_S + 1]).toEqual({});
});

test('the ease clock restarts when the stricter state is read again, and eases to the reading of the moment it runs out', () => {
  const out = run([{ g: 'ice' }, ...secs(200, { g: 'wet' }), { g: 'ice' }, ...secs(EASE_S, { g: 'snow' }), { g: 'wet' }]);
  // Back to ice at 201 s: the clock starts again at 202 s, so ice holds to 501 s and the 502 s reading (wet) is taken.
  expect(out[201]).toEqual({ g: 'ice' });
  expect(out[201 + EASE_S - 1]).toEqual({ g: 'ice' });
  expect(out.at(-1)).toEqual({ g: 'wet' });
});

test('grip and sight ease apart: a looser cap under a held grip, a lighter grip under a held cap', () => {
  let hold = nextRoadHold(NORMAL_ROAD, { g: 'snow', cap: 45 }, 0);
  hold = nextRoadHold(hold, { g: 'snow' }, 1000);
  expect(hold.road).toEqual({ g: 'snow', cap: 45 });
  hold = nextRoadHold(hold, { g: 'wet' }, 120_000);
  expect(hold.road).toEqual({ g: 'snow', cap: 45 });
  // The cap has been gone 5 min at 301 s; the grip only since 120 s.
  hold = nextRoadHold(hold, { g: 'wet' }, 301_000);
  expect(hold.road).toEqual({ g: 'snow' });
  hold = nextRoadHold(hold, { g: 'wet' }, 420_000);
  expect(hold.road).toEqual({ g: 'wet' });
});

test('an unknown reading (no serving answer) is the normal lines at once, and a stricter reading after it tightens at once', () => {
  expect(run([{ g: 'water', cap: 65 }, null, { g: 'wet' }])).toEqual([{ g: 'water', cap: 65 }, {}, { g: 'wet' }]);
  // An easing clock under way stops: the next easier reading starts its own 5 minutes from a normal road.
  expect(nextRoadHold({ road: { g: 'ice' }, gripSince: 0, capSince: null }, null, 1000)).toEqual(NORMAL_ROAD);
});

test('the stamp holds only known grips and caps, grip first', () => {
  expect(nextRoadHold(NORMAL_ROAD, { cap: 55, g: 'snow' }, 0).road).toEqual({ g: 'snow', cap: 55 });
  expect(Object.keys(nextRoadHold(NORMAL_ROAD, { cap: 55, g: 'snow' }, 0).road)).toEqual(['g', 'cap']);
  expect(nextRoadHold(NORMAL_ROAD, { g: 'mud', cap: 50 } as unknown as RoadStamp, 0).road).toEqual({});
});

test('the strictest of two states, part by part', () => {
  expect(strictestRoad(null, { g: 'wet' })).toEqual({ g: 'wet' });
  expect(strictestRoad({ g: 'water', cap: 65 }, { g: 'wet', cap: 45 })).toEqual({ g: 'water', cap: 45 });
  expect(strictestRoad({ cap: 55 }, {})).toEqual({ cap: 55 });
  expect(strictestRoad({}, {})).toEqual({});
});

// The cross-seam test (Ruling U1-I1): the HUD's limit sign shows a limit exactly when the app acts
// on it — alerts and scores in full. Inputs are the speed-limit matcher's real outputs, built by
// running `matchLimit` on candidate sets that produce each routine confidence band, then turned
// into a `LimitSample` the way the device client does (`client.ts` `toSample`, plus its
// truncated-tile cap). If either gate drifts from the other, a row of this table fails.
import { alertableFor, limitActionable, limitConfidence } from '@/core/detectors/common';
import { createSpeedingDetector } from '@/core/detectors/speeding';
import { counterIds, ctx, drive, mph, seq } from '@/core/detectors/__fixtures__/rows';
import type { LimitSample } from '@/core/engine/types';
import { TRUNCATED_CONFIDENCE_CAP } from '@/core/speedLimits/client';
import { type Candidate, type MatchResult, matchLimit } from '@/core/speedLimits/match';
import { mphToMps } from '@/lib/units';
import { hudLimitMph, hudSpeeding } from '@/ui/drive/hudSelectors';

const COURSE = 90;

const cand = (
  provider: Candidate['provider'],
  key: string,
  limitMph: number | null,
  distanceM: number,
  highway = 'primary'
): Candidate => ({ provider, key, limitMph, highway, oneway: 0, distanceM, bearingDeg: COURSE });

/** Mirrors the device client's private `toSample` (src/core/speedLimits/client.ts). */
const toSample = (r: MatchResult): LimitSample => ({
  limitMps: r.limitMph === null ? null : mphToMps(r.limitMph),
  source: r.source,
  matchConfidence: r.matchConfidence,
  parallelRoads: r.parallelRoads,
});

const matched = (...cs: Candidate[]): LimitSample => toSample(matchLimit(COURSE, cs));

/** The client's cap for a match near a tile the server truncated. */
const truncated = (s: LimitSample): LimitSample => ({
  ...s,
  matchConfidence: Math.min(s.matchConfidence, TRUNCATED_CONFIDENCE_CAP),
});

interface Row {
  name: string;
  sample: LimitSample;
  /** The matcher's confidence for this case, pinned so the table stays real matcher output. */
  match: number;
  source: LimitSample['source'];
  /** What the sign should do: the product decision behind Ruling U1-I1. */
  shown: boolean;
}

const osmNear = matched(cand('osm', 'osm:1', 35, 5));

const TABLE: Row[] = [
  { name: 'OSM tagged, near (0.95)', sample: osmNear, match: 0.95, source: 'posted', shown: true },
  {
    name: 'OSM tagged, beyond 10 m (0.85)',
    sample: matched(cand('osm', 'osm:1', 35, 15)),
    match: 0.85,
    source: 'posted',
    shown: true,
  },
  {
    name: 'HPMS fill, near (0.85)',
    sample: matched(cand('osm', 'osm:1', null, 5), cand('hpms', 'hpms:1', 40, 5)),
    match: 0.85,
    source: 'posted',
    shown: true,
  },
  {
    name: 'HPMS fill, beyond 10 m (0.75)',
    sample: matched(cand('osm', 'osm:1', null, 15), cand('hpms', 'hpms:1', 40, 15)),
    match: 0.75,
    source: 'posted',
    shown: true,
  },
  {
    name: 'AWS cache filling an untagged OSM road (0.7)',
    sample: matched(cand('osm', 'osm:1', null, 5), cand('aws', 'aws:1', 45, 5)),
    match: 0.7,
    source: 'cached',
    shown: true,
  },
  {
    name: 'AWS cache with no OSM road (0.7)',
    sample: matched(cand('aws', 'aws:1', 45, 5)),
    match: 0.7,
    source: 'cached',
    shown: true,
  },
  {
    name: 'motorway ramp (0.65)',
    sample: matched(cand('osm', 'osm:1', 35, 5, 'motorway_link')),
    match: 0.65,
    source: 'posted',
    shown: false,
  },
  {
    name: 'HPMS fill on a ramp (0.55)',
    sample: matched(cand('osm', 'osm:1', null, 5, 'motorway_link'), cand('hpms', 'hpms:1', 35, 5)),
    match: 0.55,
    source: 'posted',
    shown: false,
  },
  {
    name: 'parallel roads (0.6)',
    sample: matched(cand('osm', 'osm:1', 35, 5), cand('osm', 'osm:2', 60, 8, 'motorway')),
    match: 0.6,
    source: 'posted',
    shown: false,
  },
  {
    name: 'truncated tile nearby (capped to 0.6)',
    sample: truncated(osmNear),
    match: 0.6,
    source: 'posted',
    shown: false,
  },
  {
    // The matcher never produces `statutory` (R17); the type allows it, so the seam must hold.
    name: 'statutory default at a confident match',
    sample: { ...osmNear, source: 'statutory' },
    match: 0.95,
    source: 'statutory',
    shown: false,
  },
  { name: 'unknown (no road)', sample: matched(), match: 0, source: 'unknown', shown: false },
];

/** Does the real speeding detector alert on a sustained, clear speeding episode under `l`? */
function detectorAlerts(l: LimitSample): boolean {
  if (l.limitMps === null) return false;
  const over = l.limitMps + mph(15);
  const rows = seq([12, { speed: over, hAcc: 5, speedAcc: 0.5 }]);
  const { all } = drive(createSpeedingDetector(counterIds()), rows, l, ctx());
  return all.some((e) => e.category === 'speeding' && e.alertable);
}

describe('limit sign ⇔ alertable, over the matcher’s real outputs (Ruling U1-I1)', () => {
  test.each(TABLE)('$name', ({ sample, match, source, shown }) => {
    // The input is what the matcher and client really produce.
    expect(sample.source).toBe(source);
    expect(sample.matchConfidence).toBeCloseTo(match, 10);

    const signShown = hudLimitMph(sample, true) !== null;
    const q = limitConfidence(sample);
    const alertable = q !== null && alertableFor('scored', q);

    expect(signShown).toBe(shown);
    expect(signShown).toBe(alertable);
    expect(signShown).toBe(limitActionable(sample));
    // End to end through the real detector: an alert fires exactly where the sign is drawn.
    expect(detectorAlerts(sample)).toBe(signShown);
  });

  test.each(TABLE)('$name: the readout turns red only where the app would alert', ({ sample }) => {
    const fast = (sample.limitMps ?? mph(35)) + mph(15);
    expect(hudSpeeding(fast, true, sample)).toBe(limitActionable(sample));
  });
});

/** @jest-environment node */
// Drives over real roads from OpenStreetMap (© OpenStreetMap contributors, ODbL; fetched from the
// OSM API on 2026-10-20) through the device client, the way the drive host uses it: roads that
// showed "-" on the sign although each carries a posted limit.
import { limitActionable, limitShown } from '@/core/detectors/common';
import type { LimitSample } from '@/core/engine/types';
import type { SpeedLimitApi } from '@/core/speedLimits/api';
import { createSpeedLimitClient, SIGN_ONLY_CONFIDENCE, type SpeedLimitClient } from '@/core/speedLimits/client';
import { normalizeDeg } from '@/core/speedLimits/geometry';
import { matchLimit } from '@/core/speedLimits/match';
import { candidatesNear, decodeTile } from '@/core/speedLimits/store';
import { tileFor, tileKey } from '@/core/speedLimits/tiles';
import type { LimitSegment, TileBatchResponse } from '@/core/speedLimits/wire';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { migrate } from '@/data/db/migrate';
import { encodePolyline } from '@/lib/polyline';
import { mpsToMph } from '@/lib/units';

type Way = { id: number; highway: string; mph: number | null; oneway: -1 | 0 | 1; line: [number, number][] };

/**
 * I-405 northbound through NE 8th St, Bellevue: the 60 mph mainline (310012621, 623957745,
 * 736892506) with its untagged ramps merging and leaving within 10 m, and the southbound
 * carriageway about 25 m west.
 */
const I405: Way[] = [
  { id: 310012621, highway: 'motorway', mph: 60, oneway: 1, line: [[47.607413, -122.187368], [47.607761, -122.187573], [47.608514, -122.187907], [47.608827, -122.188043], [47.609218, -122.188185], [47.609463, -122.188254], [47.609908, -122.18835], [47.610237, -122.188423], [47.610804, -122.18849], [47.611258, -122.188508], [47.611627, -122.188517], [47.612348, -122.188503]] },
  { id: 623957745, highway: 'motorway', mph: 60, oneway: 1, line: [[47.612348, -122.188503], [47.613195, -122.1885], [47.613588, -122.1885], [47.615417, -122.1885], [47.616574, -122.188516]] },
  { id: 736892506, highway: 'motorway', mph: 60, oneway: 1, line: [[47.616574, -122.188516], [47.616903, -122.18852], [47.618395, -122.188539], [47.619869, -122.188533], [47.620423, -122.18853], [47.621378, -122.188522]] },
  { id: 531674824, highway: 'motorway_link', mph: null, oneway: 1, line: [[47.609717, -122.188148], [47.610133, -122.188259], [47.610358, -122.188299], [47.611111, -122.188325], [47.612633, -122.188215]] },
  { id: 454826562, highway: 'motorway_link', mph: null, oneway: 1, line: [[47.612348, -122.188503], [47.615316, -122.188671], [47.61539, -122.188675]] },
  { id: 531669522, highway: 'motorway_link', mph: null, oneway: 1, line: [[47.609717, -122.188148], [47.610371, -122.188212], [47.610641, -122.18821], [47.610873, -122.188187], [47.612054, -122.18805], [47.612807, -122.187962], [47.613287, -122.18791], [47.613671, -122.187914], [47.61384, -122.187946], [47.614088, -122.188026], [47.614375, -122.188141], [47.614596, -122.188177], [47.615085, -122.188195]] },
  { id: 995574460, highway: 'motorway_link', mph: null, oneway: 1, line: [[47.614403, -122.188253], [47.614507, -122.188264], [47.615404, -122.188342], [47.61636, -122.188397], [47.616574, -122.188516]] },
  { id: 531651939, highway: 'motorway_link', mph: null, oneway: 1, line: [[47.615085, -122.188195], [47.615496, -122.188264], [47.616208, -122.188273], [47.617237, -122.188317]] },
  { id: 30615045, highway: 'motorway_link', mph: null, oneway: 1, line: [[47.615485, -122.188676], [47.61691, -122.188685], [47.618229, -122.188695], [47.619585, -122.188676], [47.62033, -122.188673], [47.621097, -122.188681], [47.622098, -122.188539]] },
  { id: 428073561, highway: 'motorway_link', mph: null, oneway: 1, line: [[47.619738, -122.188902], [47.616913, -122.188801], [47.615607, -122.188754], [47.615485, -122.18875]] },
  { id: 30615048, highway: 'motorway_link', mph: null, oneway: 1, line: [[47.61539, -122.188748], [47.613306, -122.188734], [47.613015, -122.188745], [47.611948, -122.188844]] },
  { id: 880540177, highway: 'motorway', mph: 60, oneway: 1, line: [[47.616472, -122.188971], [47.615226, -122.188946], [47.613219, -122.188895], [47.611948, -122.188844]] },
  { id: 428073513, highway: 'motorway', mph: 60, oneway: 1, line: [[47.611584, -122.188828], [47.610727, -122.188747], [47.610284, -122.188681], [47.609974, -122.188604], [47.609376, -122.188466], [47.608511, -122.188187], [47.607707, -122.187853]] },
];

/** Pacific Highway (SR 99) southbound at 196th St SW, Lynnwood, and its 35 mph slip ramp (289492488) onto 196th. */
const LYNNWOOD: Way[] = [
  { id: 289487329, highway: 'trunk', mph: 45, oneway: 1, line: [[47.822139, -122.314358], [47.822012, -122.314457], [47.821557, -122.314845]] },
  { id: 289492488, highway: 'trunk_link', mph: 35, oneway: 1, line: [[47.821557, -122.314845], [47.821476, -122.314972], [47.821412, -122.315077], [47.82134, -122.315232], [47.821307, -122.315325], [47.821268, -122.315468], [47.821234, -122.315713]] },
  { id: 428284370, highway: 'trunk', mph: 45, oneway: 1, line: [[47.821557, -122.314845], [47.821324, -122.315057], [47.821299, -122.315078], [47.821225, -122.315138]] },
  { id: 289492490, highway: 'trunk', mph: 45, oneway: 1, line: [[47.821225, -122.315138], [47.821191, -122.315168], [47.821128, -122.315224]] },
  { id: 1047121713, highway: 'primary', mph: 35, oneway: 1, line: [[47.821225, -122.315138], [47.821226, -122.315305], [47.821234, -122.315713]] },
  { id: 1047121714, highway: 'primary', mph: 35, oneway: 1, line: [[47.821234, -122.315713], [47.821244, -122.316352]] },
  { id: 428073428, highway: 'primary', mph: 35, oneway: 1, line: [[47.821135, -122.31571], [47.82113, -122.315448], [47.821132, -122.315396], [47.821128, -122.315224]] },
  { id: 428074289, highway: 'trunk', mph: 45, oneway: 1, line: [[47.821128, -122.315224], [47.821066, -122.315283], [47.820873, -122.315446], [47.819847, -122.316336]] },
];

const segments = (ways: Way[]): LimitSegment[] =>
  ways.map((w) => ({
    id: String(w.id),
    provider: 'osm',
    limitMph: w.mph,
    highway: w.highway,
    oneway: w.oneway,
    line: encodePolyline(w.line.map(([lat, lng]) => ({ lat, lng }))),
  }));

const M = 111_320;
const DEG = Math.PI / 180;

/** Positions every `stepM` along `line`, `offsetM` to the right of it, with the course there. */
function drive(line: [number, number][], stepM: number, offsetM: number): { lat: number; lng: number; course: number }[] {
  const out: { lat: number; lng: number; course: number }[] = [];
  let carry = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const [lat0, lng0] = line[i]!;
    const [lat1, lng1] = line[i + 1]!;
    const kx = Math.cos(lat0 * DEG) * M;
    const dx = (lng1 - lng0) * kx;
    const dy = (lat1 - lat0) * M;
    const len = Math.hypot(dx, dy);
    const course = normalizeDeg(Math.atan2(dx, dy) / DEG);
    for (let s = carry; s < len; s += stepM) {
      const x = (dx * s) / len + (dy / len) * offsetM;
      const y = (dy * s) / len - (dx / len) * offsetM;
      out.push({ lat: lat0 + y / M, lng: lng0 + x / kx, course });
    }
    carry = (((carry - len) % stepM) + stepM) % stepM;
  }
  return out;
}

const route = (...ways: Way[]): [number, number][] => ways.flatMap((w, i) => (i === 0 ? w.line : w.line.slice(1)));

async function clientOver(ways: Way[]): Promise<SpeedLimitClient> {
  const db = await createSqlJsDb();
  await migrate(db);
  const api: SpeedLimitApi = {
    getTiles: async (keys): Promise<TileBatchResponse> => ({
      tiles: keys.map((tile) => ({ tile, expiresAt: 1_800_000_000_000, truncated: false, segments: segments(ways) })),
      fallback: null,
    }),
    lookupPoint: async () => ({ limitMph: null, source: 'unknown', matchConfidence: 0, parallelRoads: false, provider: null }),
  };
  return createSpeedLimitClient({ db, api, now: () => 1_700_000_000_000, warmAheadM: [] });
}

/** The sign's number for a row (`limitShownMph` with a good fix), or null for "-". */
const sign = (s: LimitSample | null): number | null => (s !== null && limitShown(s) && s.limitMps !== null ? Math.round(mpsToMph(s.limitMps)) : null);

/** What the matcher alone put on the sign (before the client's fallback): a limit, or null for "-". */
function matcherSign(ways: Way[], lat: number, lng: number, course: number): number | null {
  const tile = decodeTile(tileKey(tileFor(lat, lng)), 1_800_000_000_000, segments(ways), true)!;
  const r = matchLimit(course, candidatesNear([tile], { lat, lng }, 25));
  return r.source !== 'unknown' && !r.parallelRoads && r.matchConfidence >= 0.7 ? r.limitMph : null;
}

/** Every row's sign through the client, one a second, plus what the matcher alone would have shown. */
async function signs(ways: Way[], rows: { lat: number; lng: number; course: number }[], speedMps: number) {
  const client = await clientOver(ways);
  client.startTrip(rows[0]!.lat, rows[0]!.lng, rows[0]!.course);
  await client.settled();
  const out: { now: number | null; before: number | null; sample: LimitSample | null }[] = [];
  for (const r of rows) {
    const sample = client.lookup(r.lat, r.lng, r.course, { gnssValid: true, speedMps });
    await client.settled();
    out.push({ now: sign(sample), before: matcherSign(ways, r.lat, r.lng, r.course), sample });
  }
  return out;
}

describe('real roads that showed "-" with a posted limit', () => {
  it('I-405 past its ramps: 60 on the sign the whole way, sign-only where a ramp runs within 10 m', async () => {
    const mainline = route(I405[0]!, I405[1]!, I405[2]!);
    // A car in the right-hand lane, 3 m right of the carriageway's centre line, one reading a second at 60 mph.
    const rows = await signs(I405, drive(mainline, 26.8, 3), 26.8);
    expect(rows.length).toBeGreaterThan(50);
    const blankBefore = rows.filter((r) => r.before === null).length;
    expect(blankBefore).toBeGreaterThanOrEqual(10); // ~270 m the matcher alone left at "-"
    expect(rows.every((r) => r.now === 60)).toBe(true);
    // The rows the matcher alone left blank are sign-only: shown, never scored.
    for (const r of rows.filter((x) => x.before === null)) {
      expect(r.sample).toMatchObject({ source: 'statutory', matchConfidence: SIGN_ONLY_CONFIDENCE, parallelRoads: false });
      expect(limitActionable(r.sample!)).toBe(false);
    }
    // Where the mainline stands alone it is posted, and scored as before.
    expect(rows.filter((r) => r.before === 60).every((r) => r.sample?.source === 'posted' && limitActionable(r.sample))).toBe(true);
  });

  it('the Lynnwood slip ramp: 45 on Pacific Highway, then the ramp’s own 35 once it leaves, never "-" and never scored on the ramp', async () => {
    const rows = await signs(LYNNWOOD, drive(route(LYNNWOOD[0]!, LYNNWOOD[1]!), 5, 0), 5);
    expect(rows.every((r) => r.now !== null)).toBe(true);
    expect(rows[0]!.now).toBe(45);
    const onRamp = rows.slice(-6);
    expect(onRamp.every((r) => r.before === null && r.now === 35 && !limitActionable(r.sample!))).toBe(true);
  });
});

// The AWS fallback for `speed-limits` (design §4.4; plan R8): one Amazon Location Service
// `CalculateRoutes` call (geo-routes v2), signed with SigV4 by `aws4fetch`, asking for the posted
// speed limit of the road the car is on.
//
// It exists only when all three secrets are set (`createAwsRoutesClient` answers null otherwise, and
// the function then says `fallback: null` and answers `unknown`). The secrets live in the function's
// environment and never leave this file: not in a response, not in a log.
//
// What comes back is every span of the route that carries a posted limit: its `MaxSpeed`,
// converted to mph, with the route's own geometry for that span (rev1: m), never a straight
// projection of the car's heading. The route runs from behind the car to ahead of it (ruling B2
// I-1), so the handler picks the span the car is on with the device's matcher. A span this file
// cannot vouch for is left out: no speed limit, an unlimited road, a limit outside the tables'
// 5..85 mph, or fewer than two usable points. No route, or span offsets that cannot be read, is an
// empty list. A transport failure, a timeout or a non-2xx answer throws `AwsRoutesError`; the
// handler turns every failure into `unknown`, never a 5xx.
import { AwsClient } from 'aws4fetch';
import type { LatLng } from '../_shared/speedLimits/geometry';

export interface SpanLimit {
  /** The span's posted limit, whole mph rounded to the nearest 5, 5..85. */
  mph: number;
  /** The route's own geometry for that span, in travel order: 2..`MAX_LEG_POINTS` points, under `MAX_LEG_M`. */
  leg: LatLng[];
}

export interface RoutesClient {
  /** The route's spans that carry a usable limit, in travel order; empty when there are none. */
  speedLimitsAlong(origin: LatLng, dest: LatLng): Promise<SpanLimit[]>;
}

/** What `createAwsRoutesClient` reads; `Deno.env` satisfies it. */
export interface EnvReader {
  get(name: string): string | undefined;
}

/** The three secrets. All must be set or there is no fallback. */
export const AWS_ENV = {
  accessKeyId: 'AWS_ACCESS_KEY_ID',
  secretAccessKey: 'AWS_SECRET_ACCESS_KEY',
  region: 'AWS_REGION',
} as const;

/** The device abandons a request after 15 s; AWS gets a third of that, so an answer still arrives. */
export const AWS_TIMEOUT_MS = 5_000;
/** `put_limits_cache` refuses a line of more than 1000 positions. */
export const MAX_LEG_POINTS = 1000;
/**
 * `put_limits_cache` refuses a line longer than 5 km. The leg is cut a little short of that, so the
 * flat-earth length measured here can never come out under the database's geodesic one and still
 * be refused.
 */
export const MAX_LEG_M = 4_900;

const KMH_PER_MPH = 1.609344;
const M_PER_DEG = 111_320;
const DEG = Math.PI / 180;
/** An AWS region name, so a malformed secret can never steer the request to another host. */
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

/** A failed call: the HTTP status (0 for transport or timeout). No body or URL is kept. */
export class AwsRoutesError extends Error {
  constructor(readonly status: number, reason: string) {
    super(`aws routes ${reason}`);
    this.name = 'AwsRoutesError';
  }
}

/** km/h to whole mph at the nearest 5 (how US limits are posted); null outside the tables' 5..85. */
export function kmhToMph(kmh: unknown): number | null {
  if (typeof kmh !== 'number' || !Number.isFinite(kmh) || kmh <= 0) return null;
  const mph = Math.round(kmh / KMH_PER_MPH / 5) * 5;
  return mph >= 5 && mph <= 85 ? mph : null;
}

const flatM = (a: LatLng, b: LatLng): number => {
  const kx = Math.cos(((a.lat + b.lat) / 2) * DEG) * M_PER_DEG;
  return Math.hypot((b.lng - a.lng) * kx, (b.lat - a.lat) * M_PER_DEG);
};

/**
 * The positions `start..end` (both inclusive, so neighbouring spans share their boundary point) with
 * repeated points dropped, cut at `MAX_LEG_POINTS` and `MAX_LEG_M`. Null when fewer than two
 * distinct points remain or any position is not a coordinate on the globe.
 */
export function legForRange(positions: unknown, start: number, end: number): LatLng[] | null {
  if (!Array.isArray(positions)) return null;
  const last = Math.min(end, positions.length - 1);
  const leg: LatLng[] = [];
  let length = 0;
  for (let i = Math.max(0, start); i <= last && leg.length < MAX_LEG_POINTS; i += 1) {
    const p = positions[i];
    if (!Array.isArray(p) || p.length < 2) return null;
    const [lng, lat] = p;
    if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    const point = { lat, lng };
    const prev = leg[leg.length - 1];
    if (prev) {
      if (prev.lat === lat && prev.lng === lng) continue;
      const step = flatM(prev, point);
      if (length + step > MAX_LEG_M) break;
      length += step;
    }
    leg.push(point);
  }
  return leg.length >= 2 ? leg : null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);

/**
 * The usable spans of one `CalculateRoutes` response. Each span runs from its `GeometryOffset` to
 * the next span's; offsets that are missing, not whole, or go backwards make the split unknowable,
 * and then nothing is returned rather than a limit pinned to the wrong stretch of road.
 */
export function readSpanLimits(body: unknown): SpanLimit[] {
  const route = Array.isArray(obj(body)?.Routes) ? obj((obj(body)!.Routes as unknown[])[0]) : null;
  const leg = Array.isArray(route?.Legs) ? obj((route!.Legs as unknown[])[0]) : null;
  if (!leg) return [];
  const spans = obj(leg.VehicleLegDetails)?.Spans;
  const positions = obj(leg.Geometry)?.LineString;
  if (!Array.isArray(spans) || !Array.isArray(positions)) return [];
  const offsets: number[] = [];
  for (const [i, raw] of spans.entries()) {
    const offset = obj(raw)?.GeometryOffset ?? (i === 0 ? 0 : undefined);
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return [];
    if (i > 0 && offset < offsets[i - 1]!) return [];
    offsets.push(offset);
  }
  const out: SpanLimit[] = [];
  spans.forEach((raw, i) => {
    const limit = obj(obj(raw)?.SpeedLimit);
    if (!limit || limit.Unlimited === true) return;
    const mph = kmhToMph(limit.MaxSpeed);
    if (mph === null) return;
    const end = i + 1 < offsets.length ? offsets[i + 1]! : positions.length - 1;
    const legPts = legForRange(positions, offsets[i]!, end);
    if (legPts) out.push({ mph, leg: legPts });
  });
  return out;
}

export function createAwsRoutesClient(
  env: EnvReader,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {}
): RoutesClient | null {
  const accessKeyId = env.get(AWS_ENV.accessKeyId)?.trim();
  const secretAccessKey = env.get(AWS_ENV.secretAccessKey)?.trim();
  const region = env.get(AWS_ENV.region)?.trim();
  if (!accessKeyId || !secretAccessKey || !region || !REGION_RE.test(region)) return null;

  const signer = new AwsClient({ accessKeyId, secretAccessKey, region, service: 'geo-routes' });
  const endpoint = `https://routes.geo.${region}.amazonaws.com/v2/routes`;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? AWS_TIMEOUT_MS;

  return {
    async speedLimitsAlong(origin, dest) {
      const body = JSON.stringify({
        Origin: [origin.lng, origin.lat],
        Destination: [dest.lng, dest.lat],
        TravelMode: 'Car',
        SpanAdditionalFeatures: ['SpeedLimit'],
        // A plain [lng, lat] LineString instead of the default flexible polyline.
        LegGeometryFormat: 'Simple',
      });
      const signed = await signer.sign(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      let res: Response;
      try {
        res = await doFetch(signed, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const timedOut = err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new AwsRoutesError(0, timedOut ? 'timed out' : 'unreachable');
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new AwsRoutesError(res.status, `answered ${res.status}`);
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        throw new AwsRoutesError(res.status, 'answered with a body that is not JSON');
      }
      return readSpanLimits(parsed);
    },
  };
}

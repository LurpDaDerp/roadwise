import { assert, assertEquals, assertInstanceOf, assertRejects } from '@std/assert';
import {
  AWS_ENV,
  AwsRoutesError,
  createAwsRoutesClient,
  kmhToMph,
  legForRange,
  MAX_LEG_M,
  MAX_LEG_POINTS,
  readSpanLimits,
} from './aws.ts';

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const ENV: Record<string, string> = {
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: SECRET,
  AWS_REGION: 'us-west-2',
};
const env = (over: Record<string, string | undefined> = {}) => {
  const all: Record<string, string | undefined> = { ...ENV, ...over };
  return { get: (k: string) => all[k] };
};

const ORIGIN = { lat: 47.606, lng: -122.32 };
const DEST = { lat: 47.60735, lng: -122.32 };
const LINE = [
  [-122.32, 47.606],
  [-122.32, 47.6067],
  [-122.32, 47.60735],
];

const routeBody = (spans: unknown[], line: unknown = LINE) => ({
  Routes: [{ Legs: [{ Geometry: { LineString: line }, TravelMode: 'Car', VehicleLegDetails: { Spans: spans } }] }],
});

function capture(reply: () => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetchStub = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    requests.push(req);
    return Promise.resolve(reply());
  };
  return { requests, fetch: fetchStub as typeof fetch };
}

Deno.test('the three secret names are pinned', () => {
  assertEquals(AWS_ENV, { accessKeyId: 'AWS_ACCESS_KEY_ID', secretAccessKey: 'AWS_SECRET_ACCESS_KEY', region: 'AWS_REGION' });
});

Deno.test('no client unless all three secrets are set, and the region is a region', () => {
  assert(createAwsRoutesClient(env()) !== null);
  for (const over of [
    { AWS_ACCESS_KEY_ID: undefined },
    { AWS_SECRET_ACCESS_KEY: undefined },
    { AWS_REGION: undefined },
    { AWS_SECRET_ACCESS_KEY: '  ' },
    { AWS_REGION: 'evil.example.com/x' },
    { AWS_REGION: 'us-west-2.attacker' },
  ]) {
    assertEquals(createAwsRoutesClient(env(over)), null, JSON.stringify(over));
  }
});

Deno.test('one signed CalculateRoutes call: geo-routes v2, Car, SpeedLimit, simple geometry', async () => {
  const cap = capture(() => Response.json(routeBody([{ GeometryOffset: 0, SpeedLimit: { MaxSpeed: 72.42 } }])));
  const client = createAwsRoutesClient(env(), { fetch: cap.fetch })!;
  const got = await client.speedLimitsAlong(ORIGIN, DEST);
  assertEquals(got, [{ mph: 45, leg: [ORIGIN, { lat: 47.6067, lng: -122.32 }, DEST] }]);

  assertEquals(cap.requests.length, 1);
  const req = cap.requests[0];
  assertEquals(req.method, 'POST');
  assertEquals(req.url, 'https://routes.geo.us-west-2.amazonaws.com/v2/routes');
  const auth = req.headers.get('authorization') ?? '';
  assert(auth.startsWith('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/'), auth);
  assert(auth.includes('/us-west-2/geo-routes/aws4_request'), auth);
  assert(req.headers.get('x-amz-date'));
  const body = await req.text();
  assertEquals(JSON.parse(body), {
    Origin: [-122.32, 47.606],
    Destination: [-122.32, 47.60735],
    TravelMode: 'Car',
    SpanAdditionalFeatures: ['SpeedLimit'],
    LegGeometryFormat: 'Simple',
  });
  // the secret key signs; it is never sent
  assert(!body.includes(SECRET) && !auth.includes(SECRET) && !req.url.includes(SECRET));
});

Deno.test('a non-2xx answer throws with the status only', async () => {
  const cap = capture(() => new Response('{"message":"The security token included in the request is invalid"}', { status: 403 }));
  const client = createAwsRoutesClient(env(), { fetch: cap.fetch })!;
  const err = await assertRejects(() => client.speedLimitsAlong(ORIGIN, DEST), AwsRoutesError);
  assertEquals(err.status, 403);
  assertEquals(err.message, 'aws routes answered 403');
});

Deno.test('a transport failure and a timeout throw AwsRoutesError', async () => {
  const down = createAwsRoutesClient(env(), { fetch: (() => Promise.reject(new TypeError('dns'))) as typeof fetch })!;
  const e1 = await assertRejects(() => down.speedLimitsAlong(ORIGIN, DEST), AwsRoutesError);
  assertEquals([e1.status, e1.message], [0, 'aws routes unreachable']);

  const hang = ((_: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof fetch;
  const slow = createAwsRoutesClient(env(), { fetch: hang, timeoutMs: 10 })!;
  const e2 = await assertRejects(() => slow.speedLimitsAlong(ORIGIN, DEST), AwsRoutesError);
  assertEquals(e2.message, 'aws routes timed out');
});

Deno.test('a body that is not JSON throws', async () => {
  const client = createAwsRoutesClient(env(), { fetch: capture(() => new Response('<html>')).fetch })!;
  assertInstanceOf(await client.speedLimitsAlong(ORIGIN, DEST).catch((e) => e), AwsRoutesError);
});

Deno.test('km/h becomes whole mph at the nearest 5, within 5..85', () => {
  assertEquals([72.42, 40, 50, 100, 130, 137].map(kmhToMph), [45, 25, 30, 60, 80, 85]);
  assertEquals([0, -10, 145, NaN, '50', null].map(kmhToMph), [null, null, null, null, null, null]);
});

Deno.test('no route, or spans without a usable limit, is an empty list', () => {
  assertEquals(readSpanLimits({ Routes: [] }), []);
  assertEquals(readSpanLimits({}), []);
  assertEquals(readSpanLimits(routeBody([])), []);
  assertEquals(readSpanLimits(routeBody([{ GeometryOffset: 0 }])), []);
  assertEquals(readSpanLimits(routeBody([{ GeometryOffset: 0, SpeedLimit: { Unlimited: true } }])), []);
  assertEquals(readSpanLimits(routeBody([{ GeometryOffset: 0, SpeedLimit: { MaxSpeed: 200 } }])), []);
});

Deno.test('each span with a limit comes back with its own stretch of the leg, boundaries shared', () => {
  const got = readSpanLimits(routeBody([
    { GeometryOffset: 0, SpeedLimit: { MaxSpeed: 40 } },
    { GeometryOffset: 1 },
    { GeometryOffset: 1, SpeedLimit: { MaxSpeed: 80 } },
  ]));
  assertEquals(got, [
    { mph: 25, leg: [ORIGIN, { lat: 47.6067, lng: -122.32 }] },
    { mph: 50, leg: [{ lat: 47.6067, lng: -122.32 }, DEST] },
  ]);
});

Deno.test('span offsets that are missing or run backwards give nothing, not a limit on the wrong stretch', () => {
  assertEquals(readSpanLimits(routeBody([{ GeometryOffset: 0, SpeedLimit: { MaxSpeed: 40 } }, { SpeedLimit: { MaxSpeed: 80 } }])), []);
  assertEquals(
    readSpanLimits(routeBody([
      { GeometryOffset: 0, SpeedLimit: { MaxSpeed: 40 } },
      { GeometryOffset: 2, SpeedLimit: { MaxSpeed: 80 } },
      { GeometryOffset: 1, SpeedLimit: { MaxSpeed: 80 } },
    ])),
    []
  );
  // a lone first span without an offset starts at 0
  assertEquals(readSpanLimits(routeBody([{ SpeedLimit: { MaxSpeed: 40 } }])).length, 1);
});

Deno.test('a leg range drops repeated points, needs two, and refuses a position off the globe', () => {
  const end = Number.MAX_SAFE_INTEGER;
  assertEquals(legForRange([[-122.32, 47.606], [-122.32, 47.606], [-122.32, 47.607]], 0, end)?.length, 2);
  assertEquals(legForRange([[-122.32, 47.606], [-122.32, 47.606]], 0, end), null);
  assertEquals(legForRange([[-122.32, 47.606]], 0, end), null);
  assertEquals(legForRange([[-122.32, 47.606], [-190, 47.607]], 0, end), null);
  assertEquals(legForRange([[-122.32, 47.606], ['x', 47.607]], 0, end), null);
  assertEquals(legForRange('LINESTRING', 0, end), null);
  assertEquals(legForRange(LINE, 1, 2), [{ lat: 47.6067, lng: -122.32 }, DEST]);
});

Deno.test('the leg is kept within put_limits_cache bounds: 1000 positions, under 5 km', () => {
  const many = Array.from({ length: 1500 }, (_, i) => [-122.32, 47.6 + i * 1e-5]); // ~1.1 m apart
  assertEquals(legForRange(many, 0, many.length)?.length, MAX_LEG_POINTS);

  const long = Array.from({ length: 12 }, (_, i) => [-122.32, 47.6 + i * 0.005]); // ~557 m apart
  const leg = legForRange(long, 0, long.length)!;
  let m = 0;
  for (let i = 1; i < leg.length; i += 1) m += (leg[i].lat - leg[i - 1].lat) * 111_320;
  assert(m <= MAX_LEG_M && MAX_LEG_M < 5_000, String(m));
  assertEquals(leg.length, 9);
});

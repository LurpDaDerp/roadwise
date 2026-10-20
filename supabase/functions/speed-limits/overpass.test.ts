import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import {
  fetchWays,
  HIGHWAY_CLASSES,
  OVERPASS_ENDPOINTS,
  OVERPASS_USER_AGENT,
  OverpassRefused,
  OverpassRemark,
  overpassQuery,
  parseMaxspeed,
  parseOneway,
  streamElements,
  toWayRow,
  type WayRow,
} from './overpass.ts';

const CELL = { minLat: 47.6, maxLat: 47.7, minLng: -122.4, maxLng: -122.3 };

/** A body delivered in chunks of `size` bytes (so multi-byte characters and tokens straddle reads). */
const chunked = (text: string, size: number): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
      c.close();
    },
  });
};

const way = (id: number, tags: Record<string, string>, geometry: { lat: number; lon: number }[] = [{ lat: 47.61, lon: -122.31 }, { lat: 47.611, lon: -122.309 }]) => ({
  type: 'way',
  id,
  bounds: { minlat: 47.61, minlon: -122.31, maxlat: 47.611, maxlon: -122.309 },
  nodes: geometry.map((_, i) => 1000 + i),
  geometry,
  tags,
});

const reply = (elements: unknown[], extra = ''): string =>
  `{"version": 0.6, "generator": "Overpass API 0.7.62", "osm3s": {"timestamp_osm_base": "2026-10-20T01:03:51Z", "copyright": "ODbL"}, "elements": [${elements.map((e) => JSON.stringify(e)).join(',\n')}]${extra}}`;

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

// --- the query ---

Deno.test('the query names the twelve classes anchored, the cell bbox south,west,north,east, json and a 90 s timeout, out geom', () => {
  const q = overpassQuery(CELL);
  assertEquals(
    q,
    '[out:json][timeout:90];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](47.6,-122.4,47.7,-122.3);out geom;'
  );
  assertEquals(HIGHWAY_CLASSES.length, 12);
  assertEquals(OVERPASS_ENDPOINTS, ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']);
});

// --- maxspeed ---

Deno.test('maxspeed: mph as is, km/h (bare or tagged) converted to the nearest mph, knots too; 5..85 only', () => {
  const cases: [unknown, number | null][] = [
    ['25 mph', 25],
    ['25mph', 25],
    [' 60 MPH ', 60],
    ['50', 31],
    ['50 km/h', 31],
    ['80 kmh', 50],
    ['30 kph', 19],
    ['100', 62],
    ['10 knots', 12],
    ['27.5 mph', 28],
    ['5 mph', 5],
    ['85 mph', 85],
    ['4 mph', null],
    ['86 mph', null],
    ['0', null],
    ['none', null],
    ['signals', null],
    ['walk', null],
    ['variable', null],
    ['US:urban', null],
    ['DE:rural', null],
    ['25 mph;35 mph', null],
    ['25 mph|35 mph', null],
    ['twenty five', null],
    ['', null],
    [undefined, null],
    [null, null],
    [25, null],
  ];
  for (const [raw, want] of cases) assertEquals(parseMaxspeed(raw), want, `maxspeed ${JSON.stringify(raw)}`);
});

Deno.test('oneway: yes/true/1 along, -1/reverse against, no/reversible/alternating/junk both; untagged motorways and roundabouts are one-way', () => {
  assertEquals(parseOneway({ oneway: 'yes' }), 1);
  assertEquals(parseOneway({ oneway: 'true' }), 1);
  assertEquals(parseOneway({ oneway: '1' }), 1);
  assertEquals(parseOneway({ oneway: ' YES ' }), 1);
  assertEquals(parseOneway({ oneway: '-1' }), -1);
  assertEquals(parseOneway({ oneway: 'reverse' }), -1);
  assertEquals(parseOneway({ oneway: 'no' }), 0);
  assertEquals(parseOneway({ oneway: 'reversible' }), 0);
  assertEquals(parseOneway({ oneway: 'alternating' }), 0);
  assertEquals(parseOneway({ oneway: 'maybe' }), 0);
  assertEquals(parseOneway({ oneway: 'no', highway: 'motorway' }), 0);
  assertEquals(parseOneway({ highway: 'motorway' }), 1);
  assertEquals(parseOneway({ highway: 'motorway_link' }), 0);
  assertEquals(parseOneway({ highway: 'residential', junction: 'roundabout' }), 1);
  assertEquals(parseOneway({ highway: 'residential', junction: 'circular' }), 1);
  assertEquals(parseOneway({ highway: 'residential' }), 0);
  assertEquals(parseOneway({ oneway: 7 }), 0);
});

// --- elements → rows ---

Deno.test('a drivable way becomes a row: [lng, lat] line, parsed limit, raw tag, trimmed name, oneway', () => {
  const row = toWayRow(way(4748962, { highway: 'motorway', maxspeed: '60 mph', oneway: 'yes', name: '  Interstate 5  ', ref: 'I 5' }));
  assertEquals(row, {
    id: 4748962,
    highway: 'motorway',
    maxspeed_mph: 60,
    maxspeed_raw: '60 mph',
    name: 'Interstate 5',
    oneway: 1,
    line: [[-122.31, 47.61], [-122.309, 47.611]],
  });
});

Deno.test('an untagged residential way keeps null limit and name; raw and name are cut at 64 and 128 characters', () => {
  const row = toWayRow(way(7, { highway: 'residential', maxspeed: 'x'.repeat(70), name: 'n'.repeat(130) }));
  assertEquals(row?.maxspeed_mph, null);
  assertEquals(row?.maxspeed_raw?.length, 64);
  assertEquals(row?.name?.length, 128);
  assertEquals(row?.oneway, 0);
  assertEquals(toWayRow(way(8, { highway: 'residential', name: '   ' }))?.name, null);
});

Deno.test('not a row: nodes and relations, other classes (a living_street, a footway), bad ids, lines under two points or off the globe', () => {
  assertEquals(toWayRow({ type: 'node', id: 1, lat: 47.6, lon: -122.3 }), null);
  assertEquals(toWayRow({ type: 'relation', id: 1, members: [] }), null);
  assertEquals(toWayRow(way(1, { highway: 'living_street' })), null);
  assertEquals(toWayRow(way(1, { highway: 'footway' })), null);
  assertEquals(toWayRow(way(1, { highway: 'service' })), null);
  assertEquals(toWayRow(way(1, {})), null);
  assertEquals(toWayRow(way(0, { highway: 'residential' })), null);
  assertEquals(toWayRow(way(-3, { highway: 'residential' })), null);
  assertEquals(toWayRow(way(1.5, { highway: 'residential' })), null);
  assertEquals(toWayRow(way(1, { highway: 'residential' }, [{ lat: 47.61, lon: -122.31 }])), null);
  assertEquals(toWayRow(way(1, { highway: 'residential' }, [{ lat: 47.61, lon: -122.31 }, { lat: 91, lon: -122.31 }])), null);
  assertEquals(toWayRow({ ...way(1, { highway: 'residential' }), geometry: undefined }), null);
  assertEquals(toWayRow(null), null);
  assertEquals(toWayRow('way'), null);
  // a null position (a missing node) is dropped, the rest of the line stands
  const r = toWayRow({ ...way(1, { highway: 'residential' }), geometry: [{ lat: 47.61, lon: -122.31 }, null, { lat: 47.611, lon: -122.309 }] });
  assertEquals(r?.line, [[-122.31, 47.61], [-122.309, 47.611]]);
});

// --- the stream ---

Deno.test('streamElements yields each element of the array whatever the chunking, with braces and quotes inside strings and multi-byte names', async () => {
  const elements = [
    way(1, { highway: 'primary', name: 'Rue de l’Église {“quoted”} \\ "escaped" }' }),
    way(2, { highway: 'residential', 'name:ja': '東京通り', note: '[]{}' }),
    { type: 'node', id: 3, lat: 1, lon: 2, tags: { a: '}' } },
    way(4, { highway: 'tertiary' }),
  ];
  const text = reply(elements);
  for (const size of [1, 3, 7, 64, 1000, 100_000]) {
    const got = await collect(streamElements(chunked(text, size)));
    assertEquals(got, elements, `chunk size ${size}`);
  }
});

Deno.test('an empty elements array, an empty body, and a body without elements yield nothing', async () => {
  assertEquals(await collect(streamElements(chunked(reply([]), 5))), []);
  assertEquals(await collect(streamElements(chunked('', 5))), []);
  assertEquals(await collect(streamElements(chunked('{"version": 0.6}', 5))), []);
});

Deno.test('a remark after the array (Overpass ran out of time or memory) throws OverpassRemark once the partial elements are out', async () => {
  const text = reply([way(1, { highway: 'primary' })], ', "remark": "runtime error: Query timed out in \\"query\\" at line 1 after 90 seconds."');
  for (const size of [4, 4096]) {
    const got: unknown[] = [];
    const err = await assertRejects(async () => {
      for await (const el of streamElements(chunked(text, size))) got.push(el);
    }, OverpassRemark);
    assertEquals(got.length, 1);
    assertEquals(err.remark, 'runtime error: Query timed out in "query" at line 1 after 90 seconds.');
  }
});

// --- fetchWays ---

interface Call {
  url: string;
  init: RequestInit;
}

const fetcher = (answers: ((url: string) => Response | Promise<Response>)[]) => {
  const calls: Call[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const a = answers[calls.length - 1];
    if (!a) throw new Error(`unexpected fetch #${calls.length}`);
    return Promise.resolve(a(url));
  };
  return { calls, fetch };
};

const ok = (text: string) => new Response(chunked(text, 1024), { status: 200, headers: { 'content-type': 'application/json' } });

Deno.test('fetchWays POSTs the query form-encoded with the User-Agent to the first mirror and yields the drivable rows', async () => {
  const { calls, fetch } = fetcher([() => ok(reply([way(1, { highway: 'primary', maxspeed: '35 mph' }), { type: 'node', id: 2 }, way(3, { highway: 'path' })]))]);
  const rows = await collect(fetchWays(CELL, { fetch }));
  assertEquals(rows.map((r: WayRow) => r.id), [1]);
  assertEquals(rows[0].maxspeed_mph, 35);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, OVERPASS_ENDPOINTS[0]);
  assertEquals(calls[0].init.method, 'POST');
  const headers = calls[0].init.headers as Record<string, string>;
  assertEquals(headers['user-agent'], OVERPASS_USER_AGENT);
  assertEquals(headers['content-type'], 'application/x-www-form-urlencoded');
  assertEquals(calls[0].init.body, new URLSearchParams({ data: overpassQuery(CELL) }).toString());
  assert(calls[0].init.signal instanceof AbortSignal);
});

Deno.test('a mirror that refuses (429) or fails before any element is skipped for the next; both failing throws the last error', async () => {
  const good = () => ok(reply([way(1, { highway: 'primary' })]));
  const refused = fetcher([() => new Response('busy', { status: 429 }), good]);
  assertEquals((await collect(fetchWays(CELL, { fetch: refused.fetch }))).length, 1);
  assertEquals(refused.calls.map((c) => c.url), [OVERPASS_ENDPOINTS[0], OVERPASS_ENDPOINTS[1]]);

  const down = fetcher([() => Promise.reject(new TypeError('connection reset')), good]);
  assertEquals((await collect(fetchWays(CELL, { fetch: down.fetch }))).length, 1);
  assertEquals(down.calls.length, 2);

  const both = fetcher([() => new Response('', { status: 504 }), () => new Response('', { status: 429 })]);
  const err = await assertRejects(() => collect(fetchWays(CELL, { fetch: both.fetch })), OverpassRefused);
  assertEquals(err.status, 429);
  assertEquals(both.calls.length, 2);
});

Deno.test('a failure after elements have been yielded propagates (the caller holds partial data) and no other mirror is tried', async () => {
  const text = reply([way(1, { highway: 'primary' }), way(2, { highway: 'primary' })]);
  const cut = text.slice(0, text.indexOf('"id":2'));
  // pull-based: the first read gets the cut body, the next read fails (an error discards a queue)
  let pulls = 0;
  const broken = new ReadableStream<Uint8Array>({
    pull(c) {
      pulls += 1;
      if (pulls === 1) c.enqueue(new TextEncoder().encode(cut));
      else c.error(new Error('stream reset'));
    },
  });
  const { calls, fetch } = fetcher([() => new Response(broken, { status: 200 })]);
  const got: number[] = [];
  const err = await assertRejects(async () => {
    for await (const r of fetchWays(CELL, { fetch })) got.push(r.id);
  });
  assertStringIncludes(String(err), 'stream reset');
  assertEquals(got, [1]);
  assertEquals(calls.length, 1);
});

Deno.test('a remark reply propagates as OverpassRemark after its partial rows', async () => {
  const text = reply([way(1, { highway: 'primary' })], ', "remark": "runtime error: Query run out of memory"');
  const { fetch } = fetcher([() => ok(text)]);
  const got: number[] = [];
  await assertRejects(async () => {
    for await (const r of fetchWays(CELL, { fetch })) got.push(r.id);
  }, OverpassRemark);
  assertEquals(got, [1]);
});

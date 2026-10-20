import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import {
  fetchWays,
  HIGHWAY_CLASSES,
  MAX_EDGE_BYTES,
  MAX_ELEMENT_BYTES,
  MAX_REPLY_BYTES,
  OVERPASS_DE,
  OVERPASS_ENDPOINTS,
  OVERPASS_USER_AGENT,
  OverpassBudgetSpent,
  OverpassHeldBack,
  OverpassIncomplete,
  OverpassRefused,
  OverpassRemark,
  OverpassTooLarge,
  overpassQuery,
  parseMaxspeed,
  parseOneway,
  PRIVATE_COFFEE,
  streamElements,
  toWayRow,
  userAgent,
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
  // private.coffee first (no rate limit), the main instance as the fallback (fill.ts holds it to its policy)
  assertEquals(OVERPASS_ENDPOINTS, ['https://overpass.private.coffee/api/interpreter', 'https://overpass-api.de/api/interpreter']);
  assertEquals([PRIVATE_COFFEE, OVERPASS_DE], OVERPASS_ENDPOINTS);
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

Deno.test('an empty elements array yields nothing; an empty body or one without elements is incomplete, never an empty cell', async () => {
  assertEquals(await collect(streamElements(chunked(reply([]), 5))), []);
  for (const body of ['', '{"version": 0.6}', '<html><body>Service unavailable</body></html>']) {
    const err = await assertRejects(() => collect(streamElements(chunked(body, 5))), OverpassIncomplete);
    assertEquals(err.what, 'no_elements', body);
  }
});

Deno.test('a body that ends inside the elements array throws OverpassIncomplete once the whole elements are out', async () => {
  const full = reply([way(1, { highway: 'primary' }), way(2, { highway: 'residential' })]);
  for (const cut of [full.indexOf('[') + 1, full.lastIndexOf('}', full.length - 3), full.length - 2]) {
    for (const size of [3, 4096]) {
      const got: unknown[] = [];
      const err = await assertRejects(async () => {
        for await (const el of streamElements(chunked(full.slice(0, cut), size))) got.push(el);
      }, OverpassIncomplete);
      assertEquals(err.what, 'unterminated', `cut ${cut}`);
      assert(got.length <= 2);
    }
  }
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

// --- size caps (security review: the reader must never hold an unbounded body) ---

/** A lazily generated body: `head`, then `filler` repeated `times`, then `tail`, one chunk per pull. */
const generated = (head: string, filler: string, times: number, tail: string) => {
  const enc = new TextEncoder();
  let i = -1;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      i += 1;
      if (i === 0) c.enqueue(enc.encode(head));
      else if (i <= times) c.enqueue(enc.encode(filler));
      else if (i === times + 1) c.enqueue(enc.encode(tail));
      else c.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, wasCancelled: () => cancelled, pulls: () => i + 1 };
};

Deno.test('a reply past MAX_REPLY_BYTES is cut off: the reader is cancelled and OverpassTooLarge(reply) thrown after the rows so far', async () => {
  assertEquals(MAX_REPLY_BYTES, 64 * 1024 * 1024);
  const mb = ' '.repeat(1024 * 1024);
  const g = generated(reply([way(1, { highway: 'primary' })]).slice(0, -2) + ',', mb, 70, ']}');
  const got: unknown[] = [];
  const err = await assertRejects(async () => {
    for await (const el of streamElements(g.stream)) got.push(el);
  }, OverpassTooLarge);
  assertEquals(err.what, 'reply');
  assertEquals(got.length, 1);
  assert(g.wasCancelled());
  assert(g.pulls() <= 66, 'reading stopped at the cap');
});

Deno.test('one element past MAX_ELEMENT_BYTES, or a header or tail past MAX_EDGE_BYTES, is refused the same way', async () => {
  assertEquals(MAX_ELEMENT_BYTES, 512 * 1024);
  assertEquals(MAX_EDGE_BYTES, 64 * 1024);
  const kb = 'x'.repeat(1024);
  const element = generated('{"elements":[{"type":"way","id":1,"tags":{"note":"', kb, 600, '"}}]}');
  const e1 = await assertRejects(() => collect(streamElements(element.stream)), OverpassTooLarge);
  assertEquals(e1.what, 'element');
  assert(element.wasCancelled());

  const header = generated('{"version":0.6,"note":"', kb, 70, '","elements":[]}');
  const e2 = await assertRejects(() => collect(streamElements(header.stream)), OverpassTooLarge);
  assertEquals(e2.what, 'header');

  const tail = generated('{"elements":[],"note":"', kb, 70, '"}');
  const e3 = await assertRejects(() => collect(streamElements(tail.stream)), OverpassTooLarge);
  assertEquals(e3.what, 'tail');

  // a long but legitimate way (2000 nodes, about 100 KB) is fine
  const long = way(1, { highway: 'primary' }, Array.from({ length: 2000 }, (_, i) => ({ lat: 47.6 + i * 1e-5, lon: -122.3 })));
  assertEquals((await collect(streamElements(chunked(reply([long]), 4096)))).length, 1);
});

Deno.test('fetchWays never retries an oversized reply on another mirror', async () => {
  const kb = 'x'.repeat(1024);
  const { calls, fetch } = fetcher([
    () => new Response(generated('{"elements":[{"type":"way","id":1,"tags":{"note":"', kb, 600, '"}}]}').stream, { status: 200 }),
    () => ok(reply([way(1, { highway: 'primary' })])),
  ]);
  await assertRejects(() => collect(fetchWays(CELL, { fetch })), OverpassTooLarge);
  assertEquals(calls.length, 1);
});

// --- the usage policies' hooks ---

Deno.test('the User-Agent names the app, and the operator contact when one is configured', () => {
  assertEquals(OVERPASS_USER_AGENT, 'RoadWise/1.0 (speed-limit road layer; Supabase edge function; OSM data under ODbL)');
  assertEquals(userAgent(null), OVERPASS_USER_AGENT);
  assertEquals(userAgent('ops@example.org'), 'RoadWise/1.0 (speed-limit road layer; Supabase edge function; OSM data under ODbL; contact: ops@example.org)');
});

Deno.test('a gate that holds a mirror back skips it unasked; holding all back throws OverpassHeldBack; a refusal is reported to it', async () => {
  const seen: string[] = [];
  const refusedLog: [string, number][] = [];
  const gate = (allowed: (url: string) => boolean) => ({
    allow: (url: string) => {
      seen.push(url);
      return Promise.resolve(allowed(url));
    },
    megabyte: () => Promise.resolve(true),
    refused: (url: string, status: number) => void refusedLog.push([url, status]),
  });
  const good = () => ok(reply([way(1, { highway: 'primary' })]));
  const skipFirst = fetcher([good]);
  assertEquals((await collect(fetchWays(CELL, { fetch: skipFirst.fetch, gate: gate((u) => u !== PRIVATE_COFFEE) }))).length, 1);
  assertEquals(skipFirst.calls.map((c) => c.url), [OVERPASS_DE]);

  const none = fetcher([]);
  await assertRejects(() => collect(fetchWays(CELL, { fetch: none.fetch, gate: gate(() => false) })), OverpassHeldBack);
  assertEquals(none.calls.length, 0);

  const busy = fetcher([() => new Response('busy', { status: 429 }), good]);
  await collect(fetchWays(CELL, { fetch: busy.fetch, gate: gate(() => true) }));
  assertEquals(refusedLog, [[PRIVATE_COFFEE, 429]]);
});

Deno.test('the byte hook is asked once per MiB; a no cancels the read with OverpassBudgetSpent, and no other mirror is tried', async () => {
  // Five ways with a 300 KB name each: about 1.5 MiB, so exactly one MiB boundary is crossed.
  const big = reply([1, 2, 3, 4, 5].map((id) => way(id, { highway: 'residential', name: 'x'.repeat(300_000) })));
  let asked = 0;
  const yes = fetcher([() => ok(big)]);
  const rows = await collect(
    fetchWays(CELL, { fetch: yes.fetch, gate: { allow: () => Promise.resolve(true), megabyte: () => Promise.resolve(++asked > 0), refused: () => undefined } })
  );
  assertEquals(rows.length, 5);
  assertEquals(asked, 1);

  const no = fetcher([() => ok(big), () => ok(big)]);
  await assertRejects(
    () => collect(fetchWays(CELL, { fetch: no.fetch, gate: { allow: () => Promise.resolve(true), megabyte: () => Promise.resolve(false), refused: () => undefined } })),
    OverpassBudgetSpent
  );
  assertEquals(no.calls.length, 1);
});

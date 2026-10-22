#!/usr/bin/env node
'use strict';
/**
 * Builds routes.json, the road library the Julian demo seed drives on: for each route a real driving
 * path from Valhalla (OpenStreetMap data, the FOSSGIS public server), with the posted speed limit and
 * road class of every stretch from Valhalla's trace_attributes. Run it once; routes.json is committed,
 * so the seed itself needs no network.
 *
 *   node scripts/seed-julian/fetch-routes.js
 *
 * The roads and limits are OpenStreetMap data (© OpenStreetMap contributors, ODbL), routed and matched by Valhalla.
 *
 * Stored per route: the path as a precision-6 encoded polyline, and the stretches as
 * [endIndex, limitMph, roadClass] triples (a stretch runs from the previous endIndex to its own).
 */

const fs = require('fs');
const path = require('path');

const { PLACES, ROUTES } = require('./places.js');

const OUT = path.join(__dirname, 'routes.json');
const VALHALLA = 'https://valhalla1.openstreetmap.de';
const GAP_MS = 1300;

/** Roads Valhalla does not tag with a limit: the usual urban limit of their class, mph. */
const CLASS_LIMIT = { motorway: 60, trunk: 50, primary: 35, secondary: 35, tertiary: 30, unclassified: 25, residential: 25, service_other: 15 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;

async function post(endpoint, body, tries = 4) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(`${VALHALLA}/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) return await res.json();
      if (res.status !== 429 && res.status < 500) throw new Error(`${endpoint}: HTTP ${res.status} ${await res.text()}`);
    } catch (err) {
      if (attempt === tries) throw err;
    }
    await sleep(2500 * attempt);
  }
  throw new Error(`${endpoint}: gave up`);
}

function decode6(s) {
  const out = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < s.length) {
    for (const axis of [0, 1]) {
      let shift = 0;
      let result = 0;
      let b;
      do {
        b = s.charCodeAt(i++) - 63;
        result |= (b & 31) << shift;
        shift += 5;
      } while (b >= 32);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += d;
      else lng += d;
    }
    out.push([lat / 1e6, lng / 1e6]);
  }
  return out;
}

const roundLimit = (kph) => Math.max(15, Math.round(kph / 1.609344 / 5) * 5);

async function stretches(shape, points) {
  const res = await post('trace_attributes', {
    encoded_polyline: shape,
    costing: 'auto',
    shape_match: 'edge_walk',
    filters: { attributes: ['edge.speed_limit', 'edge.road_class', 'edge.end_shape_index', 'edge.length'], action: 'include' },
  });
  const out = [];
  let lastEnd = 0;
  for (const e of res.edges ?? []) {
    const end = Math.min(points - 1, e.end_shape_index);
    if (end <= lastEnd) continue;
    const mph = typeof e.speed_limit === 'number' && e.speed_limit > 0 ? roundLimit(e.speed_limit) : CLASS_LIMIT[e.road_class] ?? 25;
    const prev = out[out.length - 1];
    if (prev && prev[1] === mph && prev[2] === e.road_class) prev[0] = end;
    else out.push([end, mph, e.road_class]);
    lastEnd = end;
  }
  if (out.length === 0 || lastEnd < points - 1) {
    const tail = out[out.length - 1];
    if (tail) tail[0] = points - 1;
    else out.push([points - 1, 25, 'residential']);
  }
  return out;
}

async function main() {
  const library = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  for (const r of ROUTES) {
    if (library[r.id] && (r.alts ?? 0) === 0) continue;
    if (library[r.id] && library[`${r.id}~1`]) continue;
    const from = PLACES[r.from];
    const to = PLACES[r.to];
    const via = (r.via ?? []).map((k) => ({ lat: PLACES[k][0], lon: PLACES[k][1], type: 'through' }));
    const body = {
      locations: [{ lat: from[0], lon: from[1], type: 'break' }, ...via, { lat: to[0], lon: to[1], type: 'break' }],
      costing: 'auto',
      alternates: r.alts ?? 0,
      directions_options: { units: 'miles' },
    };
    const res = await post('route', body);
    const trips = [res.trip, ...(res.alternates ?? []).map((a) => a.trip)];
    for (let k = 0; k < trips.length; k += 1) {
      const trip = trips[k];
      const id = k === 0 ? r.id : `${r.id}~${k}`;
      const shape = trip.legs.map((l) => l.shape)[0];
      if (trip.legs.length !== 1) throw new Error(`${id}: expected one leg`);
      const points = decode6(shape);
      const edges = await stretches(shape, points.length);
      library[id] = { from: r.from, to: r.to, miles: Math.round(trip.summary.length * 100) / 100, shape, edges };
      console.log(`${id}: ${library[id].miles} mi, ${points.length} pts, ${edges.length} stretches, limits ${[...new Set(edges.map((e) => e[1]))].join('/')}`);
    }
    fs.writeFileSync(OUT, JSON.stringify(library));
  }
  console.log(`\n${Object.keys(library).length} routes in ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

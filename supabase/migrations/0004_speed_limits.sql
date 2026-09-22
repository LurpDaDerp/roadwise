-- 0004_speed_limits: road data for speed limits, the AWS fallback's cache, and the SQL the
-- `speed-limits` edge function calls (design §4.2, §4.4; plan task B1).
--
--   * osm.ways and hpms.sections hold open road data (Washington first, loaded by the
--     supabase/data pipeline as postgres). They live in their own schemas, which the Data API does
--     not expose, and only service_role may read them (convention 14). limits_cache holds answers
--     from AWS Location for roads the open data could not answer; it is service-role only too.
--   * the four functions are SECURITY INVOKER: they run with the edge function's service-role
--     privileges and can never exceed them. Execute is granted to service_role alone.
--   * segment keys. The device's matcher breaks exact distance ties on the candidate key, so the
--     tile segment `id` the device sees and the `segment_key` speed_limit_candidates returns are
--     one string: the OSM way id, the HPMS section id, or the cache row's key, which is the first
--     16 hex digits of sha256 of the caller's key (put_limits_cache derives it; a CHECK pins the
--     shape). Every key fits the tile schema's 24 characters, and both ends compose the matcher's
--     candidate key the same way, as `${provider}:${id}` (src/core/speedLimits/store.ts).
--   * the device's tile schema is all-or-nothing, so nothing here can send an HPMS or cache segment
--     without a limit (both columns are NOT NULL), a line that is not a single LineString, or a
--     line longer than the schema's 4096 characters (parts are chunked at 256 vertices).
--   * candidate distance and bearing are measured the way the device's nearestOnPolyline measures
--     them (equirectangular metres at the query point's latitude, the bearing of the nearest
--     segment in digitised order), so device and server rank the same roads the same way.
--   * a truncated tile keeps its most important roads: past 2000 segments the cut falls on minor
--     classes first (S2 review), so the car's own road outlives a parallel side street.

create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------------------
-- schemas: service_role only, including for whatever postgres creates here later (convention 3)
-- ---------------------------------------------------------------------------
create schema osm;
create schema hpms;
revoke all on schema osm from public;
revoke all on schema hpms from public;
grant usage on schema osm to service_role;
grant usage on schema hpms to service_role;

alter default privileges for role postgres in schema osm revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema osm revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema osm revoke all on functions from public, anon, authenticated;
alter default privileges for role postgres in schema osm grant select on tables to service_role;
alter default privileges for role postgres in schema osm grant usage, select on sequences to service_role;
alter default privileges for role postgres in schema osm grant execute on functions to service_role;
alter default privileges for role postgres in schema hpms revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema hpms revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema hpms revoke all on functions from public, anon, authenticated;
alter default privileges for role postgres in schema hpms grant select on tables to service_role;
alter default privileges for role postgres in schema hpms grant usage, select on sequences to service_role;
alter default privileges for role postgres in schema hpms grant execute on functions to service_role;

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------
-- OSM ways of the twelve road classes the pipeline imports (design §4.6). An untagged way keeps a
-- null limit: it is still sent, so the matcher can see the road and answer "unknown" on it.
create table osm.ways (
  osm_id bigint primary key check (osm_id > 0),
  geom extensions.geometry(LineString, 4326) not null,
  highway text not null check (highway in (
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
    'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link')),
  maxspeed_mph smallint check (maxspeed_mph between 5 and 85),
  maxspeed_raw text check (char_length(maxspeed_raw) <= 64),
  name text check (char_length(name) <= 128),
  oneway smallint not null default 0 check (oneway in (-1, 0, 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- HPMS sections (FHWA), loaded only where a posted limit is recorded
create table hpms.sections (
  id bigint primary key check (id > 0),
  geom extensions.geometry(MultiLineString, 4326) not null,
  speed_limit_mph smallint not null check (speed_limit_mph between 5 and 85),
  f_system smallint check (f_system between 1 and 7),
  state_code smallint not null check (state_code between 1 and 78),
  route_id text check (char_length(route_id) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- AWS Location answers, kept at most 30 days. The key is put_limits_cache's short hash, never the
-- caller's raw identifier, so the tile id built from it fits the device's 24 characters.
-- Each row exists because some driver's lookup caused it, so it keeps no time of day: created_at
-- and updated_at are stored floored to the UTC day (limits_cache_touch), and so is expires_at: the
-- ttls are whole days, so an exact expiry would give the lookup's time of day back (re-audit R-M1).
-- The tile answer floors a row's expiry to the UTC day as well (security review I-1). The 30-day CHECK is measured from the
-- floored created_at, so it is never looser than 30 days from the lookup.
create table public.limits_cache (
  segment_key text primary key
    check (char_length(segment_key) between 1 and 128)
    check (segment_key ~ '^[0-9a-f]{16}$'),
  geom extensions.geometry(LineString, 4326) not null check (extensions.st_npoints(geom) between 2 and 1000),
  limit_mph smallint not null check (limit_mph between 5 and 85),
  heading_deg numeric check (heading_deg >= 0 and heading_deg < 360),
  provider text not null default 'aws' check (provider = 'aws'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at <= created_at + interval '30 days')
);

create index ways_geom_gist on osm.ways using gist (geom);
create index sections_geom_gist on hpms.sections using gist (geom);
create index limits_cache_geom_gist on public.limits_cache using gist (geom);
-- the retention job (design §4.5) deletes expired rows
create index limits_cache_expires_at_idx on public.limits_cache (expires_at);

create trigger ways_touch before update on osm.ways for each row execute function public.touch_updated_at();
create trigger sections_touch before update on hpms.sections for each row execute function public.touch_updated_at();
-- the cache's stamps carry the day, never the moment of the lookup that caused the row
create or replace function public.limits_cache_day_stamps() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := date_trunc('day', coalesce(new.created_at, now()), 'UTC');
  else
    new.created_at := date_trunc('day', new.created_at, 'UTC');
  end if;
  new.updated_at := date_trunc('day', now(), 'UTC');
  -- floored, so never later than the expiry asked for; the queries keep `expires_at > now()`
  new.expires_at := date_trunc('day', new.expires_at, 'UTC');
  return new;
end $$;
create trigger limits_cache_touch before insert or update on public.limits_cache for each row execute function public.limits_cache_day_stamps();

-- ---------------------------------------------------------------------------
-- speed_limit_candidates: every road near a point, one row per road, nearest first
-- ---------------------------------------------------------------------------
create or replace function public.speed_limit_candidates(p_lat double precision, p_lng double precision, p_radius_m int)
returns table (provider text, segment_key text, limit_mph int, highway text, oneway int, distance_m double precision, bearing_deg double precision)
language plpgsql stable security invoker set search_path = public, extensions as $$
declare
  v_pt extensions.geometry;
  v_dlat double precision;
  v_dlng double precision;
  v_box extensions.geometry;
  -- the device's metres per degree (geometry.ts M_PER_DEG) and its longitude scale at this point
  v_ky constant double precision := 111320;
  v_kx double precision;
begin
  -- NaN sorts above every number and so fails these ranges too
  if p_lat is null or p_lng is null or not (p_lat between -90 and 90) or not (p_lng between -180 and 180) then
    raise exception 'lat must be between -90 and 90 and lng between -180 and 180' using errcode = 'invalid_parameter_value';
  end if;
  if p_radius_m is null or p_radius_m < 5 or p_radius_m > 50 then
    raise exception 'radius_m must be between 5 and 50' using errcode = 'invalid_parameter_value';
  end if;

  v_pt := extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326);
  -- the index prefilter: a box computed from metres (a degree of latitude is never under 110.5 km;
  -- the longitude span is taken at the box's poleward edge), never ST_Expand in degrees
  v_dlat := p_radius_m / 110000.0;
  v_dlng := least(180, p_radius_m / (110000.0 * greatest(cos(radians(least(89.9, abs(p_lat) + v_dlat))), 0.001)));
  v_box := extensions.st_makeenvelope(p_lng - v_dlng, p_lat - v_dlat, p_lng + v_dlng, p_lat + v_dlat, 4326);
  v_kx := cos(p_lat * (pi() / 180)) * v_ky;

  return query
  with near as (
    select 'osm'::text as prov, w.osm_id::text as key, w.maxspeed_mph::int as lim, w.highway as hw, w.oneway::int as ow, w.geom as g
      from osm.ways w
      where w.geom operator(extensions.&&) v_box
        and extensions.st_dwithin(w.geom::extensions.geography, v_pt::extensions.geography, p_radius_m)
    union all
    select 'hpms'::text, s.id::text, s.speed_limit_mph::int, 'road'::text, 0, d.geom
      from hpms.sections s
      cross join lateral extensions.st_dump(s.geom) d
      where s.geom operator(extensions.&&) v_box
        and extensions.st_dwithin(d.geom::extensions.geography, v_pt::extensions.geography, p_radius_m)
    union all
    -- a cache row with a heading is a one-way road (B2 stores one only then). Its line is stored in
    -- canonical orientation, so the heading says which way along it traffic runs: 1 with, -1 against
    select 'aws'::text, c.segment_key, c.limit_mph::int, 'road'::text,
      case when c.heading_deg is null then 0
      when abs(mod((c.heading_deg::double precision - degrees(extensions.st_azimuth(extensions.st_startpoint(c.geom), extensions.st_endpoint(c.geom))))::numeric + 540, 360) - 180) <= 90 then 1
      else -1 end, c.geom
      from public.limits_cache c
      where c.expires_at > now()
        and c.geom operator(extensions.&&) v_box
        and extensions.st_dwithin(c.geom::extensions.geography, v_pt::extensions.geography, p_radius_m)
  ),
  measured as (
    select n.prov, n.key, n.lim, n.hw, n.ow, m.d, m.b
    from near n
    cross join lateral (
      -- the nearest non-degenerate segment, first in digitised order on a tie (nearestOnPolyline)
      select q.d, q.b from (
        select sg.idx,
          sqrt((sg.ax + sg.t * sg.dx) ^ 2 + (sg.ay + sg.t * sg.dy) ^ 2) as d,
          case when degrees(atan2(sg.dx, sg.dy)) < 0 then degrees(atan2(sg.dx, sg.dy)) + 360 else degrees(atan2(sg.dx, sg.dy)) end as b
        from (
          select e.idx, e.ax, e.ay, e.dx, e.dy,
            greatest(0.0, least(1.0, -(e.ax * e.dx + e.ay * e.dy) / (e.dx * e.dx + e.dy * e.dy))) as t
          from (
            select ds.path[1] as idx,
              (extensions.st_x(extensions.st_startpoint(ds.geom)) - p_lng) * v_kx as ax,
              (extensions.st_y(extensions.st_startpoint(ds.geom)) - p_lat) * v_ky as ay,
              (extensions.st_x(extensions.st_endpoint(ds.geom)) - p_lng) * v_kx - (extensions.st_x(extensions.st_startpoint(ds.geom)) - p_lng) * v_kx as dx,
              (extensions.st_y(extensions.st_endpoint(ds.geom)) - p_lat) * v_ky - (extensions.st_y(extensions.st_startpoint(ds.geom)) - p_lat) * v_ky as dy
            from extensions.st_dumpsegments(n.g) ds
          ) e
          where e.dx * e.dx + e.dy * e.dy > 0
        ) sg
      ) q
      order by q.d, q.idx
      limit 1
    ) m
  ),
  per_road as (
    -- one row per road: a multi-part HPMS section answers with its nearest part
    select distinct on (x.prov, x.key) x.prov, x.key, x.lim, x.hw, x.ow, x.d, case when x.b >= 360 then 0 else x.b end as b
    from measured x
    order by x.prov, x.key, x.d
  )
  select r.prov, r.key, r.lim, r.hw, r.ow, r.d, r.b
  from per_road r
  order by r.d, r.prov || ':' || r.key
  limit 20;
end $$;

-- ---------------------------------------------------------------------------
-- speed_limit_tiles: up to four z15 tiles of segments for the device's prefetch
-- ---------------------------------------------------------------------------
-- statement_timeout is in the function's config because PostgREST (v12+) applies a function's
-- statement_timeout to the RPC transaction: B2 abandons a call after 5 s, and this ends the query
-- then too, so one dense four-tile call cannot hold a pooled connection (security M-3)
create or replace function public.speed_limit_tiles(p_keys text[]) returns jsonb
language plpgsql stable security invoker set search_path = public, extensions set statement_timeout = '5s' as $$
declare
  v_key text;
  v_x int;
  v_y int;
  v_lat_n double precision;
  v_lat_s double precision;
  v_box extensions.geometry;
  v_tiles jsonb := '[]'::jsonb;
  v_tile jsonb;
begin
  if p_keys is null or coalesce(array_ndims(p_keys), 1) <> 1 or cardinality(p_keys) < 1 or cardinality(p_keys) > 4 then
    raise exception 'tiles must name 1 to 4 tile keys' using errcode = 'invalid_parameter_value';
  end if;
  foreach v_key in array p_keys loop
    if v_key is null or v_key !~ '^15/(0|[1-9][0-9]{0,4})/(0|[1-9][0-9]{0,4})$'
       or split_part(v_key, '/', 2)::int >= 32768 or split_part(v_key, '/', 3)::int >= 32768 then
      raise exception 'tile keys must be z15 keys 15/x/y' using errcode = 'invalid_parameter_value';
    end if;
  end loop;
  if (select count(distinct k) from unnest(p_keys) k) <> cardinality(p_keys) then
    raise exception 'tile keys must be distinct' using errcode = 'invalid_parameter_value';
  end if;

  foreach v_key in array p_keys loop
    v_x := split_part(v_key, '/', 2)::int;
    v_y := split_part(v_key, '/', 3)::int;
    -- the tile's north and south edges; a ground metre is 1/cos(lat) mercator units, taken at the
    -- poleward edge so the 30 m buffer is never short anywhere in the tile
    v_lat_n := degrees(atan(sinh(pi() * (1 - 2 * v_y / 32768.0))));
    v_lat_s := degrees(atan(sinh(pi() * (1 - 2 * (v_y + 1) / 32768.0))));
    v_box := extensions.st_transform(
      extensions.st_expand(extensions.st_tileenvelope(15, v_x, v_y), 30.0 / cos(radians(greatest(abs(v_lat_n), abs(v_lat_s))))),
      4326);

    with src as (
      select 'osm'::text as prov, w.osm_id::text as key, w.maxspeed_mph::int as lim, w.highway as hw, w.oneway::int as ow,
        -- the cut order past 2000 segments: major classes survive, minor ones go first
        case w.highway
          when 'motorway' then 1 when 'motorway_link' then 2 when 'trunk' then 3 when 'trunk_link' then 4
          when 'primary' then 5 when 'primary_link' then 6 when 'secondary' then 7 when 'secondary_link' then 8
          when 'tertiary' then 9 when 'tertiary_link' then 10 when 'unclassified' then 11 else 12 end as rank,
        1 as part, w.geom as g, null::timestamptz as expires
      from osm.ways w
      where w.geom operator(extensions.&&) v_box and extensions.st_intersects(w.geom, v_box)
      union all
      select 'hpms'::text, s.id::text, s.speed_limit_mph::int, 'road'::text, 0,
        case s.f_system when 1 then 1 when 2 then 3 when 3 then 5 when 4 then 7 when 5 then 9 when 6 then 9 when 7 then 12 else 13 end,
        d.path[1], d.geom, null::timestamptz
      from hpms.sections s
      cross join lateral extensions.st_dump(s.geom) d
      where s.geom operator(extensions.&&) v_box and extensions.st_intersects(d.geom, v_box)
      union all
      -- cache rows are few and are the only answer their road has: they are never cut
      select 'aws'::text, c.segment_key, c.limit_mph::int, 'road'::text,
      case when c.heading_deg is null then 0
      when abs(mod((c.heading_deg::double precision - degrees(extensions.st_azimuth(extensions.st_startpoint(c.geom), extensions.st_endpoint(c.geom))))::numeric + 540, 360) - 180) <= 90 then 1
      else -1 end,
        0, 1, c.geom, c.expires_at
      from public.limits_cache c
      where c.expires_at > now() and c.geom operator(extensions.&&) v_box and extensions.st_intersects(c.geom, v_box)
    ),
    clipped as (
      -- clip to the buffered tile, keep only line parts, and drop what 5-decimal rounding collapses
      select s.prov, s.key, s.lim, s.hw, s.ow, s.rank, s.part, cp.path[1] as cpart,
        extensions.st_removerepeatedpoints(extensions.st_snaptogrid(cp.geom, 0.00001)) as cg
      from src s
      cross join lateral extensions.st_dump(extensions.st_clipbybox2d(s.g, v_box::extensions.box2d)) cp
      where extensions.st_geometrytype(cp.geom) = 'ST_LineString'
    ),
    parts as (
      -- chunks of at most 256 vertices keep every encoded line far under the schema's 4096 characters
      select c.prov, c.key, c.lim, c.hw, c.ow, c.rank, c.part, c.cpart, ch.i,
        extensions.st_makeline(array(
          select extensions.st_pointn(c.cg, j) from generate_series(ch.i, least(ch.i + 255, extensions.st_npoints(c.cg))) j order by j)) as pg
      from clipped c
      cross join lateral generate_series(1, extensions.st_npoints(c.cg) - 1, 255) ch(i)
      where extensions.st_geometrytype(c.cg) = 'ST_LineString' and extensions.st_npoints(c.cg) >= 2 and extensions.st_length(c.cg) > 0
    ),
    ranked as (
      select p.*, row_number() over (order by p.rank, p.prov, p.key, p.part, p.cpart, p.i) as rn, count(*) over () as total
      from parts p
      where p.prov = 'osm' or p.lim is not null
    )
    select jsonb_build_object(
      'tile', v_key,
      -- a cache row's expiry counts floored to the UTC day: never later than the truth (the device
      -- refreshes early, not late), and never the moment of the lookup behind it (I-1)
      'expiresAt', floor(extract(epoch from least(now() + interval '30 days', (select min(date_trunc('day', s.expires, 'UTC')) from src s))) * 1000)::bigint,
      'truncated', coalesce(max(r.total), 0) > 2000,
      'segments', coalesce(jsonb_agg(jsonb_build_object(
          'id', r.key,
          'provider', r.prov,
          'limitMph', r.lim,
          'highway', r.hw,
          'oneway', r.ow,
          'line', extensions.st_asencodedpolyline(r.pg, 5)) order by r.rn) filter (where r.rn <= 2000), '[]'::jsonb))
    into v_tile
    from ranked r;

    v_tiles := v_tiles || jsonb_build_array(v_tile);
  end loop;

  return jsonb_build_object('tiles', v_tiles);
end $$;

-- ---------------------------------------------------------------------------
-- put_limits_cache: store one AWS answer for up to 30 days; returns the key it is stored under
-- ---------------------------------------------------------------------------
create or replace function public.put_limits_cache(p_key text, p_line jsonb, p_limit_mph int, p_heading numeric, p_ttl_days int) returns text
language plpgsql volatile security invoker set search_path = public, extensions as $$
declare
  v_geom extensions.geometry;
  v_key text;
  v_bad_line constant text := 'line must be a GeoJSON LineString of 2 to 1000 positions on the globe, under 5 km';
begin
  if p_key is null or char_length(p_key) < 1 or char_length(p_key) > 128 then
    raise exception 'key must be 1 to 128 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_limit_mph is null or p_limit_mph < 5 or p_limit_mph > 85 then
    raise exception 'limit_mph must be between 5 and 85' using errcode = 'invalid_parameter_value';
  end if;
  -- NaN sorts above 360 and is refused with it
  if p_heading is not null and (p_heading < 0 or p_heading >= 360) then
    raise exception 'heading must be at least 0 and below 360' using errcode = 'invalid_parameter_value';
  end if;
  if p_ttl_days is null or p_ttl_days < 1 or p_ttl_days > 30 then
    raise exception 'ttl_days must be between 1 and 30' using errcode = 'invalid_parameter_value';
  end if;
  if p_line is null or jsonb_typeof(p_line) <> 'object' or pg_column_size(p_line) > 65536
     or p_line ->> 'type' is distinct from 'LineString' or jsonb_typeof(p_line -> 'coordinates') is distinct from 'array'
     or jsonb_array_length(p_line -> 'coordinates') not between 2 and 1000 then
    raise exception '%', v_bad_line using errcode = 'invalid_parameter_value';
  end if;
  begin
    v_geom := extensions.st_setsrid(extensions.st_force2d(extensions.st_geomfromgeojson(p_line)), 4326);
  exception when others then
    raise exception '%', v_bad_line using errcode = 'invalid_parameter_value';
  end;
  if v_geom is null or extensions.st_geometrytype(v_geom) <> 'ST_LineString' or extensions.st_isempty(v_geom)
     or extensions.st_npoints(v_geom) not between 2 and 1000
     or extensions.st_xmin(v_geom::extensions.box3d) < -180 or extensions.st_xmax(v_geom::extensions.box3d) > 180
     or extensions.st_ymin(v_geom::extensions.box3d) < -90 or extensions.st_ymax(v_geom::extensions.box3d) > 90
     or not (extensions.st_length(v_geom::extensions.geography) > 0 and extensions.st_length(v_geom::extensions.geography) <= 5000) then
    raise exception '%', v_bad_line using errcode = 'invalid_parameter_value';
  end if;

  -- opportunistic retention (review M-1; the scheduled job is M8's): at most 100 expired rows per
  -- call, so no call pays for a backlog, and rows another call is purging are skipped, not waited on
  delete from public.limits_cache
    where segment_key in (
      select c.segment_key from public.limits_cache c
      where c.expires_at <= now()
      order by c.expires_at
      limit 100
      for update skip locked);

  -- one canonical orientation (ruling B2 I-1): the vertex order of a stored line must not say which
  -- way the driver behind the lookup was going. Reversed when the first vertex sorts after the last,
  -- by lng then lat; the heading (one-way roads only) keeps the direction of traffic
  if (extensions.st_x(extensions.st_startpoint(v_geom)), extensions.st_y(extensions.st_startpoint(v_geom)))
     > (extensions.st_x(extensions.st_endpoint(v_geom)), extensions.st_y(extensions.st_endpoint(v_geom))) then
    v_geom := extensions.st_reverse(v_geom);
  end if;

  v_key := left(encode(sha256(convert_to(p_key, 'UTF8')), 'hex'), 16);
  -- a refresh is a new answer: created_at restarts with it (floored to the day by the trigger), so
  -- the 30-day CHECK bounds each answer. Measured from that floor, a 30-day ttl ends at the start of
  -- the UTC day 30 days on, up to a day short; B2's 7-10 day ttls are unaffected.
  insert into public.limits_cache (segment_key, geom, limit_mph, heading_deg, provider, expires_at, created_at)
    values (v_key, v_geom, p_limit_mph, p_heading, 'aws',
      least(now() + make_interval(days => p_ttl_days), date_trunc('day', now(), 'UTC') + interval '30 days'), now())
  on conflict (segment_key) do update
    set geom = excluded.geom,
        limit_mph = excluded.limit_mph,
        heading_deg = excluded.heading_deg,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at;
  return v_key;
end $$;

-- ---------------------------------------------------------------------------
-- take_rate_limit: one take from a per-user budget of p_max per window; false when it is spent
-- ---------------------------------------------------------------------------
create or replace function public.take_rate_limit(p_user uuid, p_key text, p_window interval, p_max int) returns boolean
language plpgsql volatile security invoker set search_path = public, extensions as $$
declare
  v_start timestamptz;
  v_count int;
begin
  if p_user is null then
    raise exception 'user is required' using errcode = 'invalid_parameter_value';
  end if;
  -- `dispute_7d` is record_dispute's mutex row (0002), never a budget
  if p_key is null or p_key !~ '^[a-z][a-z0-9_]{0,63}$' or p_key = 'dispute_7d' then
    raise exception 'key must be a rate-limit key' using errcode = 'invalid_parameter_value';
  end if;
  if p_window is null or p_window < interval '1 second' or p_window > interval '31 days' then
    raise exception 'window must be between 1 second and 31 days' using errcode = 'invalid_parameter_value';
  end if;
  if p_max is null or p_max < 1 or p_max > 100000 then
    raise exception 'max must be between 1 and 100000' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.rate_limits (user_id, key, window_start, count) values (p_user, p_key, now(), 0)
    on conflict (user_id, key) do nothing;
  select window_start, count into v_start, v_count
    from public.rate_limits where user_id = p_user and key = p_key for update;
  if v_start + p_window <= now() then
    v_start := now();
    v_count := 0;
  end if;
  if v_count >= p_max then
    update public.rate_limits set window_start = v_start, count = v_count where user_id = p_user and key = p_key;
    return false;
  end if;
  update public.rate_limits set window_start = v_start, count = v_count + 1 where user_id = p_user and key = p_key;
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- function grants: the edge function's service-role client only
-- ---------------------------------------------------------------------------
revoke all on function public.speed_limit_candidates(double precision, double precision, int) from public, anon, authenticated;
revoke all on function public.speed_limit_tiles(text[]) from public, anon, authenticated;
revoke all on function public.put_limits_cache(text, jsonb, int, numeric, int) from public, anon, authenticated;
revoke all on function public.take_rate_limit(uuid, text, interval, int) from public, anon, authenticated;
revoke all on function public.limits_cache_day_stamps() from public, anon, authenticated;
grant execute on function public.speed_limit_candidates(double precision, double precision, int) to service_role;
grant execute on function public.speed_limit_tiles(text[]) to service_role;
grant execute on function public.put_limits_cache(text, jsonb, int, numeric, int) to service_role;
grant execute on function public.take_rate_limit(uuid, text, interval, int) to service_role;

-- ---------------------------------------------------------------------------
-- RLS: on everywhere, no policies (service_role bypasses RLS; nothing else has a grant)
-- ---------------------------------------------------------------------------
alter table osm.ways enable row level security;
alter table hpms.sections enable row level security;
alter table public.limits_cache enable row level security;

-- ---------------------------------------------------------------------------
-- table grants (convention 14): no anon/authenticated grants; service_role reads the road data and
-- reads/writes the cache (the retention job deletes from it)
-- ---------------------------------------------------------------------------
revoke all on osm.ways, hpms.sections, public.limits_cache from public, anon, authenticated, service_role;
grant select on osm.ways to service_role;
grant select on hpms.sections to service_role;
grant select, insert, update, delete on public.limits_cache to service_role;

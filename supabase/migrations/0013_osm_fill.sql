-- 0013_osm_fill: osm.ways fills itself from OpenStreetMap, one cell at a time, as drivers reach new
-- areas (the crowdsourced speed layer), plus a single-point lookup for the server and for debugging.
--
--   * osm.ways (0002) was meant to be loaded by the offline supabase/data pipeline, which never ran
--     on the hosted project, so the table was empty and every sign read "—". Now the `speed-limits`
--     edge function fills it: when a tile request touches a cell that is not loaded, the function
--     claims the cell here, fetches its drivable ways from a public Overpass mirror in the
--     background, upserts them in batches through osm_upsert_ways, and marks the cell done. The
--     device sees the tile flagged `filling` meanwhile and asks again seconds later.
--   * a cell is a fixed 0.1° × 0.1° square of the lat/lng grid (about 11 km × 7.5 km at 47° N, the
--     brief's "~10 km" box), keyed by its floor indices: cell_y = floor(lat / 0.1),
--     cell_x = floor(lng / 0.1). The edge function's fill.ts computes the same cells.
--   * osm_claim_fill_cell is the atomic claim: one `insert … on conflict do update … where` under
--     the row's lock, so two requests arriving together never fetch one cell twice. A claim left
--     'filling' for 5 minutes (a killed isolate) can be retaken; a 'failed' cell (Overpass down, a
--     partial reply) is retaken after 10 minutes; a cell 'released' (the app-wide or the user's
--     Overpass budget was spent, so nothing was tried) is claimable at once; a 'done' cell is
--     refreshed after 30 days.
--   * the functions are SECURITY INVOKER like 0002's: they run with the edge function's
--     service-role privileges and can never exceed them. Execute is granted to service_role alone,
--     and the writers refuse any other JWT role in their first statement (require_service_role).
--     service_role gains insert/update on osm.ways for the upsert; nothing else changes its grants.
--   * osm_upsert_ways validates every way the way put_limits_cache validates a line: a row the
--     table could not hold (an unknown class, a one-point line, a coordinate off the globe) is
--     skipped, never the cause of a failed batch, and the count returned is of rows written.
--   * get_current_speed_limit answers one point: the nearest osm way within 20 m whose local
--     azimuth lies within 25° of the heading (or of its reverse on a two-way road), its posted
--     limit or the class default the device's matcher uses (DEFAULT_LIMIT_MPH in
--     src/core/speedLimits/match.ts), flagged is_default. The device keeps matching locally from
--     tiles; this is for the server and for a quick check from SQL.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------
-- One row per cell the fill has ever claimed. `attempts` counts claims, so a cell that keeps
-- failing can be spotted; `way_count` is the last successful fill's row count (diagnostics).
create table osm.filled_cells (
  cell_y int not null check (cell_y between -900 and 899),
  cell_x int not null check (cell_x between -1800 and 1799),
  status text not null check (status in ('filling', 'done', 'failed', 'released')),
  claimed_at timestamptz not null default now(),
  filled_at timestamptz,
  way_count int not null default 0 check (way_count >= 0),
  attempts int not null default 1 check (attempts >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (cell_y, cell_x)
);
create trigger filled_cells_touch before update on osm.filled_cells for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- osm_claim_fill_cell: 'claimed' when this caller must fill the cell now, 'done' when it is loaded
-- and fresh, 'filling' when another caller holds it (or it failed recently)
-- ---------------------------------------------------------------------------
create or replace function public.osm_claim_fill_cell(p_y int, p_x int) returns text
language plpgsql volatile security invoker set search_path = public as $$
declare
  v_status text;
begin
  perform public.require_service_role('osm_claim_fill_cell');
  if p_y is null or p_x is null or p_y not between -900 and 899 or p_x not between -1800 and 1799 then
    raise exception 'cell must be a 0.1 degree grid cell: y in -900..899, x in -1800..1799' using errcode = 'invalid_parameter_value';
  end if;

  -- the claim and the take are one statement: the conflict path updates under the row lock, and
  -- only when the row is claimable, so concurrent callers see exactly one 'claimed'
  insert into osm.filled_cells (cell_y, cell_x, status, claimed_at, attempts)
    values (p_y, p_x, 'filling', now(), 1)
  on conflict (cell_y, cell_x) do update
    set status = 'filling', claimed_at = now(), attempts = osm.filled_cells.attempts + 1
    where (osm.filled_cells.status = 'filling' and osm.filled_cells.claimed_at <= now() - interval '5 minutes')
       or (osm.filled_cells.status = 'failed' and osm.filled_cells.updated_at <= now() - interval '10 minutes')
       or osm.filled_cells.status = 'released'
       or (osm.filled_cells.status = 'done' and osm.filled_cells.filled_at <= now() - interval '30 days')
  returning 'claimed' into v_status;
  if v_status is not null then
    return v_status;
  end if;

  select case c.status when 'done' then 'done' else 'filling' end into v_status
    from osm.filled_cells c where c.cell_y = p_y and c.cell_x = p_x;
  return coalesce(v_status, 'filling');
end $$;

-- ---------------------------------------------------------------------------
-- osm_finish_fill_cell: the claim's outcome ('done', 'failed' or 'released'); true when the cell
-- was ours to finish
-- ---------------------------------------------------------------------------
create or replace function public.osm_finish_fill_cell(p_y int, p_x int, p_outcome text, p_way_count int) returns boolean
language plpgsql volatile security invoker set search_path = public as $$
begin
  perform public.require_service_role('osm_finish_fill_cell');
  if p_y is null or p_x is null or p_outcome is null or p_outcome not in ('done', 'failed', 'released') then
    raise exception 'cell and an outcome of done, failed or released are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_way_count is not null and p_way_count < 0 then
    raise exception 'way_count must be at least 0' using errcode = 'invalid_parameter_value';
  end if;
  -- only a cell still claimed can be finished: a stale claim another caller retook is theirs now
  update osm.filled_cells
    set status = p_outcome,
        filled_at = case when p_outcome = 'done' then now() else filled_at end,
        way_count = case when p_outcome = 'done' then coalesce(p_way_count, 0) else way_count end
    where cell_y = p_y and cell_x = p_x and status = 'filling';
  return found;
end $$;

-- ---------------------------------------------------------------------------
-- osm_upsert_ways: one batch of parsed Overpass ways into osm.ways; the number of rows written
-- ---------------------------------------------------------------------------
-- Each element: { id, highway, maxspeed_mph | null, maxspeed_raw | null, name | null,
-- oneway (-1 | 0 | 1), line: [[lng, lat], …] }. A way already stored is rewritten only when
-- something changed (the touch trigger then moves updated_at); an identical one costs nothing.
create or replace function public.osm_upsert_ways(p_ways jsonb) returns int
language plpgsql volatile security invoker set search_path = public, extensions as $$
declare
  v_n int;
begin
  perform public.require_service_role('osm_upsert_ways');
  if p_ways is null or jsonb_typeof(p_ways) <> 'array' or jsonb_array_length(p_ways) not between 1 and 1000
     or pg_column_size(p_ways) > 8388608 then
    raise exception 'ways must be a JSON array of 1 to 1000 ways under 8 MB' using errcode = 'invalid_parameter_value';
  end if;

  with raw as (
    select w from jsonb_array_elements(p_ways) w where jsonb_typeof(w) = 'object'
  ),
  parsed as (
    select
      (w ->> 'id')::bigint as osm_id,
      w ->> 'highway' as highway,
      (w ->> 'maxspeed_mph')::int as maxspeed_mph,
      left(w ->> 'maxspeed_raw', 64) as maxspeed_raw,
      left(w ->> 'name', 128) as name,
      coalesce((w ->> 'oneway')::int, 0) as oneway,
      w -> 'line' as line
    from raw
    where (w ->> 'id') ~ '^[1-9][0-9]{0,17}$'
      and w ->> 'highway' in (
        'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
        'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link')
      and (w ->> 'maxspeed_mph' is null or (w ->> 'maxspeed_mph') ~ '^[0-9]{1,3}$')
      and (w ->> 'oneway' is null or (w ->> 'oneway') in ('-1', '0', '1'))
      and jsonb_typeof(w -> 'line') = 'array'
      and jsonb_array_length(w -> 'line') between 2 and 2000
  ),
  lines as (
    select p.osm_id, p.highway,
      case when p.maxspeed_mph between 5 and 85 then p.maxspeed_mph end as maxspeed_mph,
      p.maxspeed_raw, p.name, p.oneway,
      -- positions that are not a [lng, lat] pair of numbers on the globe are dropped; the line is
      -- then judged on what is left
      extensions.st_setsrid(extensions.st_makeline(array(
        select extensions.st_makepoint((c.c ->> 0)::double precision, (c.c ->> 1)::double precision)
        from jsonb_array_elements(p.line) with ordinality as c(c, n)
        where jsonb_typeof(c.c) = 'array' and jsonb_array_length(c.c) >= 2
          and jsonb_typeof(c.c -> 0) = 'number' and jsonb_typeof(c.c -> 1) = 'number'
          and (c.c ->> 0)::double precision between -180 and 180
          and (c.c ->> 1)::double precision between -90 and 90
        order by c.n)), 4326) as geom
    from parsed p
  ),
  good as (
    -- one row per id (a batch may repeat a way); a line the table could not hold is skipped
    select distinct on (l.osm_id) l.osm_id, l.highway, l.maxspeed_mph, l.maxspeed_raw, l.name, l.oneway, l.geom
    from lines l
    where l.geom is not null
      and extensions.st_geometrytype(l.geom) = 'ST_LineString'
      and extensions.st_npoints(l.geom) between 2 and 2000
      and extensions.st_length(l.geom::extensions.geography) > 0
    order by l.osm_id
  ),
  written as (
    insert into osm.ways (osm_id, geom, highway, maxspeed_mph, maxspeed_raw, name, oneway)
      select g.osm_id, g.geom, g.highway, g.maxspeed_mph, g.maxspeed_raw, g.name, g.oneway from good g
    on conflict (osm_id) do update
      set geom = excluded.geom,
          highway = excluded.highway,
          maxspeed_mph = excluded.maxspeed_mph,
          maxspeed_raw = excluded.maxspeed_raw,
          name = excluded.name,
          oneway = excluded.oneway
      where (osm.ways.highway, osm.ways.maxspeed_mph, osm.ways.maxspeed_raw, osm.ways.name, osm.ways.oneway)
              is distinct from (excluded.highway, excluded.maxspeed_mph, excluded.maxspeed_raw, excluded.name, excluded.oneway)
         or not extensions.st_orderingequals(osm.ways.geom, excluded.geom)
    returning 1
  )
  select count(*) into v_n from written;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- get_current_speed_limit: the limit at one point on one heading, or no row
-- ---------------------------------------------------------------------------
create or replace function public.get_current_speed_limit(p_lat double precision, p_lon double precision, p_heading double precision)
returns table (osm_id bigint, name text, highway text, limit_mph int, is_default boolean, distance_m double precision)
language plpgsql stable security invoker set search_path = public, extensions as $$
declare
  v_pt extensions.geometry;
  v_dlat double precision;
  v_dlng double precision;
  v_box extensions.geometry;
  v_radius_m constant double precision := 20;
  v_tol_deg constant double precision := 25;
begin
  -- NaN sorts above every number and so fails these ranges too
  if p_lat is null or p_lon is null or not (p_lat between -90 and 90) or not (p_lon between -180 and 180) then
    raise exception 'lat must be between -90 and 90 and lon between -180 and 180' using errcode = 'invalid_parameter_value';
  end if;
  if p_heading is null or not (p_heading >= 0 and p_heading < 360) then
    raise exception 'heading must be at least 0 and below 360' using errcode = 'invalid_parameter_value';
  end if;

  v_pt := extensions.st_setsrid(extensions.st_makepoint(p_lon, p_lat), 4326);
  -- the index prefilter, in metres as speed_limit_candidates computes it
  v_dlat := v_radius_m / 110000.0;
  v_dlng := least(180, v_radius_m / (110000.0 * greatest(cos(radians(least(89.9, abs(p_lat) + v_dlat))), 0.001)));
  v_box := extensions.st_makeenvelope(p_lon - v_dlng, p_lat - v_dlat, p_lon + v_dlng, p_lat + v_dlat, 4326);

  return query
  with near as (
    select w.osm_id as id, w.name as nm, w.highway as hw, w.maxspeed_mph as lim, w.oneway as ow, w.geom as g,
      extensions.st_distance(w.geom::extensions.geography, v_pt::extensions.geography) as d,
      extensions.st_linelocatepoint(w.geom, v_pt) as f
    from osm.ways w
    where w.geom operator(extensions.&&) v_box
      and extensions.st_dwithin(w.geom::extensions.geography, v_pt::extensions.geography, v_radius_m)
  ),
  oriented as (
    -- the road's direction where the car is: the azimuth across a short window of the line around
    -- the nearest point, in digitised order (null on a degenerate line)
    select n.*, degrees(extensions.st_azimuth(
        extensions.st_lineinterpolatepoint(n.g, greatest(0.0, n.f - 0.001)),
        extensions.st_lineinterpolatepoint(n.g, least(1.0, n.f + 0.001)))) as az
    from near n
  ),
  passing as (
    select o.*,
      abs(mod((p_heading - o.az)::numeric + 540, 360) - 180) as along,
      abs(mod((p_heading - o.az + 180)::numeric + 540, 360) - 180) as against
    from oriented o
    where o.az is not null
  )
  select p.id, p.nm, p.hw,
    coalesce(p.lim::int, case p.hw
      when 'motorway' then 65 when 'motorway_link' then 45
      when 'trunk' then 55 when 'trunk_link' then 40
      when 'primary' then 45 when 'primary_link' then 35
      when 'secondary' then 40 when 'secondary_link' then 30
      when 'tertiary' then 35 when 'tertiary_link' then 30
      when 'unclassified' then 30 when 'residential' then 25 end),
    p.lim is null,
    p.d
  from passing p
  where (p.ow >= 0 and p.along <= v_tol_deg) or (p.ow <= 0 and p.against <= v_tol_deg)
  order by p.d, p.id
  limit 1;
end $$;

-- ---------------------------------------------------------------------------
-- function grants: the edge function's service-role client only
-- ---------------------------------------------------------------------------
revoke all on function public.osm_claim_fill_cell(int, int) from public, anon, authenticated;
revoke all on function public.osm_finish_fill_cell(int, int, text, int) from public, anon, authenticated;
revoke all on function public.osm_upsert_ways(jsonb) from public, anon, authenticated;
revoke all on function public.get_current_speed_limit(double precision, double precision, double precision) from public, anon, authenticated;
grant execute on function public.osm_claim_fill_cell(int, int) to service_role;
grant execute on function public.osm_finish_fill_cell(int, int, text, int) to service_role;
grant execute on function public.osm_upsert_ways(jsonb) to service_role;
grant execute on function public.get_current_speed_limit(double precision, double precision, double precision) to service_role;

-- ---------------------------------------------------------------------------
-- RLS and table grants (convention 14): service_role writes the fill's rows, nothing else sees them
-- ---------------------------------------------------------------------------
alter table osm.filled_cells enable row level security;
revoke all on osm.filled_cells from public, anon, authenticated, service_role;
grant select, insert, update on osm.filled_cells to service_role;
grant insert, update on osm.ways to service_role;

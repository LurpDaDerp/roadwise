-- 0021_osm_fill_v2: the road layer holds more of the roads drivers use, its cells are filled again
-- when the edge function reads OpenStreetMap differently, an empty cell is checked again after a
-- day, and a refill drops the ways OpenStreetMap no longer has (speed-limits fill.ts FILL_VERSION 2).
--
--   * osm.ways also holds living streets, `road` (a way not yet classified) and service roads; the
--     fill loads a service road only where it posts a limit (a parking aisle or a driveway without
--     one would only crowd the street beside it). None of the three has a class default, so an
--     untagged one never shows a number, and the tile function ranks them with residential streets
--     (its `else 12`).
--   * A two-way road with a different limit each way (`maxspeed:forward` / `:backward`) arrives as
--     two one-way rows over one line, the second keyed 2^50 above the way's id; nothing here needs
--     to know.
--   * osm.filled_cells.fill_version is the road-layer version a done cell was filled with.
--     osm_claim_fill_cell(p_y, p_x, p_version) also hands out a done cell filled by an older
--     version, so a change to the classes or to how a limit is read reaches every area once a
--     driver needs it again (budgets and the per-isolate queue pace the refill), and a cell done
--     with no ways once that is a day old: a mirror that answered a well-formed but empty reply for
--     a populated area would otherwise blank it for 30 days, and a cell over water costs one tiny
--     query a day while someone drives past it. osm_finish_fill_cell(…, p_version) records the
--     version. Both default p_version to 1, so the function code deployed before this migration
--     keeps working until the new code is deployed.
--   * osm.ways.seen_at is when a fill last returned the way. osm_upsert_ways stamps every way it is
--     given, an unchanged one included (it now returns the number of ways it stored, so a cell's
--     way_count is its ways, not the ones that changed), and a fill that finishes done deletes the
--     ways lying wholly inside its cell that it did not return (deleted or reclassified in
--     OpenStreetMap, split into new ways, a direction pair that became one row), so a refill never
--     leaves an old road beside the real one to make the match ambiguous. "Not returned" is a
--     stamp older than the claim by 5 minutes or more, so a clock that steps back a little never
--     costs a road the fill just stored. A way crossing the cell's edge is left alone.

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------
alter table osm.ways drop constraint ways_highway_check;
alter table osm.ways add constraint ways_highway_check check (highway in (
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
  'living_street', 'road', 'service'));

alter table osm.ways add column seen_at timestamptz;
-- each way as last seen by the fill that wrote it (its updated_at, the touch trigger held off)
alter table osm.ways disable trigger ways_touch;
update osm.ways set seen_at = updated_at;
alter table osm.ways enable trigger ways_touch;
alter table osm.ways alter column seen_at set default now();
alter table osm.ways alter column seen_at set not null;

alter table osm.filled_cells add column fill_version int not null default 1 check (fill_version >= 1);

-- ---------------------------------------------------------------------------
-- osm_claim_fill_cell: 'claimed' when this caller must fill the cell now, 'done' when it is loaded,
-- fresh and of this version, 'filling' when another caller holds it (or it failed recently)
-- ---------------------------------------------------------------------------
drop function public.osm_claim_fill_cell(int, int);
create function public.osm_claim_fill_cell(p_y int, p_x int, p_version int default 1) returns text
language plpgsql volatile security invoker set search_path = public as $$
declare
  v_status text;
begin
  perform public.require_service_role('osm_claim_fill_cell');
  if p_y is null or p_x is null or p_y not between -900 and 899 or p_x not between -1800 and 1799 then
    raise exception 'cell must be a 0.1 degree grid cell: y in -900..899, x in -1800..1799' using errcode = 'invalid_parameter_value';
  end if;
  if p_version is null or p_version < 1 then
    raise exception 'version must be at least 1' using errcode = 'invalid_parameter_value';
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
       or (osm.filled_cells.status = 'done' and (
             osm.filled_cells.filled_at <= now() - interval '30 days'
          or osm.filled_cells.fill_version < p_version
          or (osm.filled_cells.way_count = 0 and osm.filled_cells.filled_at <= now() - interval '1 day')))
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
-- was ours to finish. Done also records the version and drops the cell's ways the fill did not see.
-- ---------------------------------------------------------------------------
drop function public.osm_finish_fill_cell(int, int, text, int);
create function public.osm_finish_fill_cell(p_y int, p_x int, p_outcome text, p_way_count int, p_version int default 1) returns boolean
language plpgsql volatile security invoker set search_path = public, extensions as $$
declare
  v_claimed timestamptz;
  v_box extensions.geometry;
begin
  perform public.require_service_role('osm_finish_fill_cell');
  if p_y is null or p_x is null or p_outcome is null or p_outcome not in ('done', 'failed', 'released') then
    raise exception 'cell and an outcome of done, failed or released are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_way_count is not null and p_way_count < 0 then
    raise exception 'way_count must be at least 0' using errcode = 'invalid_parameter_value';
  end if;
  if p_version is null or p_version < 1 then
    raise exception 'version must be at least 1' using errcode = 'invalid_parameter_value';
  end if;
  -- only a cell still claimed can be finished: a stale claim another caller retook is theirs now
  update osm.filled_cells
    set status = p_outcome,
        filled_at = case when p_outcome = 'done' then now() else filled_at end,
        way_count = case when p_outcome = 'done' then coalesce(p_way_count, 0) else way_count end,
        fill_version = case when p_outcome = 'done' then p_version else fill_version end
    where cell_y = p_y and cell_x = p_x and status = 'filling'
    returning claimed_at into v_claimed;
  if v_claimed is null then
    return false;
  end if;

  if p_outcome = 'done' then
    v_box := extensions.st_makeenvelope(p_x * 0.1, p_y * 0.1, (p_x + 1) * 0.1, (p_y + 1) * 0.1, 4326);
    delete from osm.ways w
      where w.geom operator(extensions.&&) v_box
        and extensions.st_coveredby(w.geom, v_box)
        and w.seen_at < v_claimed - interval '5 minutes';
  end if;
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- osm_upsert_ways: one batch of parsed Overpass ways into osm.ways; the number of ways stored
-- ---------------------------------------------------------------------------
-- Each element: { id, highway, maxspeed_mph | null, maxspeed_raw | null, name | null,
-- oneway (-1 | 0 | 1), line: [[lng, lat], …] }. Every way given is stamped seen, so a way already
-- stored is rewritten even when nothing about it changed.
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
        'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
        'living_street', 'road', 'service')
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
    insert into osm.ways (osm_id, geom, highway, maxspeed_mph, maxspeed_raw, name, oneway, seen_at)
      select g.osm_id, g.geom, g.highway, g.maxspeed_mph, g.maxspeed_raw, g.name, g.oneway, now() from good g
    on conflict (osm_id) do update
      set geom = excluded.geom,
          highway = excluded.highway,
          maxspeed_mph = excluded.maxspeed_mph,
          maxspeed_raw = excluded.maxspeed_raw,
          name = excluded.name,
          oneway = excluded.oneway,
          seen_at = excluded.seen_at
    returning 1
  )
  select count(*) into v_n from written;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- function grants: the edge function's service-role client only
-- ---------------------------------------------------------------------------
revoke all on function public.osm_claim_fill_cell(int, int, int) from public, anon, authenticated;
revoke all on function public.osm_finish_fill_cell(int, int, text, int, int) from public, anon, authenticated;
revoke all on function public.osm_upsert_ways(jsonb) from public, anon, authenticated;
grant execute on function public.osm_claim_fill_cell(int, int, int) to service_role;
grant execute on function public.osm_finish_fill_cell(int, int, text, int, int) to service_role;
grant execute on function public.osm_upsert_ways(jsonb) to service_role;

-- the fill deletes the ways a refill no longer finds
grant delete on osm.ways to service_role;

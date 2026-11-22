-- 0047_osm_fill_ceiling: a ceiling on the self-filling road layer (speed-limits fill.ts).
--
-- Any signed-in account can name any tile on Earth, and every cell its requests reach is loaded
-- from Overpass and kept. The hourly and per-minute budgets bound how fast that happens, not how
-- much, so a few accounts asking for city after city could fill the database's disk, and a
-- Supabase project past its disk limit turns read-only: every write in the app would fail.
--
--   * osm.fill_ceiling holds one row: the most bytes osm.ways may take (table, indexes and TOAST,
--     as pg_total_relation_size counts them) before areas never loaded stop being loaded. 250 MB
--     to start: about twenty times the layer drivers had loaded by November 2026 (12 MB, 12 cells,
--     33,860 ways), and half of the Free plan's 500 MB database. On a bigger plan the owner raises
--     it, for example
--       update osm.fill_ceiling set max_bytes = 4294967296;  -- 4 GB
--     and with no row there is no ceiling.
--   * osm_claim_fill_cell answers 'full' for a cell that has never finished loading (no row, or
--     one with no filled_at) once osm.ways is at the ceiling: nothing is claimed and no row is
--     written. A cell that has loaded is claimed exactly as before, so loaded areas keep their
--     30-day refresh and their refill for a new road-layer version, and below the ceiling nothing
--     changes. The size is read only for a cell that has never loaded, so a claim on a loaded
--     cell costs what it did. The function reads 'full' as a cell still filling (the device keeps
--     asking for its tiles) and logs that the ceiling is reached; the deployed function before it
--     already reads any unknown answer as filling.

-- ---------------------------------------------------------------------------
-- table
-- ---------------------------------------------------------------------------
create table osm.fill_ceiling (
  id boolean primary key default true check (id),
  max_bytes bigint not null check (max_bytes > 0)
);
insert into osm.fill_ceiling (max_bytes) values (262144000); -- 250 MB

-- RLS and table grants (convention 14): the fill's service-role client reads it, nothing else
alter table osm.fill_ceiling enable row level security;
revoke all on osm.fill_ceiling from public, anon, authenticated, service_role;
grant select on osm.fill_ceiling to service_role;

-- ---------------------------------------------------------------------------
-- osm_claim_fill_cell: 0021's, plus the ceiling for a cell that has never loaded
-- ---------------------------------------------------------------------------
create or replace function public.osm_claim_fill_cell(p_y int, p_x int, p_version int default 1) returns text
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

  -- an area never loaded is not started while the layer is at its ceiling; a loaded one always is
  if not exists (select 1 from osm.filled_cells c where c.cell_y = p_y and c.cell_x = p_x and c.filled_at is not null) then
    if pg_catalog.pg_total_relation_size('osm.ways'::regclass) >= (select f.max_bytes from osm.fill_ceiling f) then
      return 'full';
    end if;
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

revoke all on function public.osm_claim_fill_cell(int, int, int) from public, anon, authenticated;
grant execute on function public.osm_claim_fill_cell(int, int, int) to service_role;

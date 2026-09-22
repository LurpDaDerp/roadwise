-- osm.parse_maxspeed_mph: an OSM `maxspeed` tag value to a posted limit in mph, or null.
--
-- Used only by the import pipeline (transform.sql); the runtime never calls it. It lives in the osm
-- schema, where 0004's default privileges give service_role execute and clients nothing.
--
-- Rules (plan task B3, R17):
--   * '45 mph' / '45mph' (any case, at most one space) -> 45, when 5..85
--   * a bare integer that is a multiple of 5 in 5..85 -> that many mph (US posted limits)
--   * everything else -> null: 'none', 'signals', 'walk', 'US:*' statutory defaults, ';'-lists,
--     conditional values ('20 mph @ (...)'), km/h / kph / knots, decimals, leading zeros, values
--     outside 5..85. A null limit leaves the road "unknown", never a guessed number (§13.2).
create or replace function osm.parse_maxspeed_mph(p_raw text) returns smallint
language sql immutable parallel safe set search_path = pg_catalog as $$
  select case
    when s.v ~ '^[1-9][0-9]? ?mph$' then
      case when m.n between 5 and 85 then m.n end
    when s.v ~ '^[1-9][0-9]?$' then
      case when m.n between 5 and 85 and m.n % 5 = 0 then m.n end
  end::smallint
  from (select lower(btrim(p_raw, E' \t\r\n')) as v) s
  cross join lateral (select substring(s.v from '^([0-9]{1,2})')::int as n) m
$$;

comment on function osm.parse_maxspeed_mph(text) is
  'Import pipeline only (supabase/data): OSM maxspeed to mph, or null. See supabase/data/sql/parse_maxspeed.sql.';

-- osm.way_limit_mph: the limit transform.sql stores for one way.
--
--   * the Canadian km/h guard (ruling B3 concerns 4-6): an extract keeps border-crossing ways whole,
--     and in Canada a bare number is km/h. On a way whose northmost point is north of
--     p_kmh_north_of, only an explicit mph value counts. The value is normalised exactly as the
--     parser normalises it (the same trim, the same case), so no padding lets a bare number past
--     the guard and into the parser (review m1). p_kmh_north_of null: no km/h line.
--   * directional tags (review m6): a way whose maxspeed:forward or maxspeed:backward is present
--     and does not give the same limit as its maxspeed has more than one limit, so it gets none,
--     the parser's rule for ;-lists. Directional tags alone are not used.
create or replace function osm.guarded_maxspeed_mph(p_raw text, p_way_max_lat double precision, p_kmh_north_of double precision)
returns smallint
language sql immutable parallel safe set search_path = pg_catalog as $$
  select case
    when p_kmh_north_of is not null and p_way_max_lat > p_kmh_north_of
         and lower(btrim(p_raw, E' \t\r\n')) !~ 'mph$' then null
    else osm.parse_maxspeed_mph(p_raw)
  end
$$;

create or replace function osm.way_limit_mph(p_maxspeed text, p_forward text, p_backward text,
  p_way_max_lat double precision, p_kmh_north_of double precision)
returns smallint
language sql immutable parallel safe set search_path = pg_catalog as $$
  select case
    when b.mph is null then null
    when p_forward is not null and osm.guarded_maxspeed_mph(p_forward, p_way_max_lat, p_kmh_north_of) is distinct from b.mph then null
    when p_backward is not null and osm.guarded_maxspeed_mph(p_backward, p_way_max_lat, p_kmh_north_of) is distinct from b.mph then null
    else b.mph
  end
  from (select osm.guarded_maxspeed_mph(p_maxspeed, p_way_max_lat, p_kmh_north_of) as mph) b
$$;

comment on function osm.guarded_maxspeed_mph(text, double precision, double precision) is
  'Import pipeline only (supabase/data): parse_maxspeed_mph plus the km/h guard north of a latitude.';
comment on function osm.way_limit_mph(text, text, text, double precision, double precision) is
  'Import pipeline only (supabase/data): the limit stored for one OSM way. See supabase/data/sql/parse_maxspeed.sql.';

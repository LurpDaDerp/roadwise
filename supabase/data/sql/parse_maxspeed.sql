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

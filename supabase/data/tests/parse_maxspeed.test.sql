-- osm.parse_maxspeed_mph: an OSM `maxspeed` value to a posted limit in mph, or null (plan task B3);
-- osm.way_limit_mph: the limit transform.sql stores for one way, which adds the Canadian km/h guard
-- (ruling B3 concerns 4-6, review m1) and the directional-tag rule (review m6) on top of the parser.
--
-- Only an explicit mph value, or a bare integer that reads as a US posted limit (a multiple of 5 in
-- 5..85), is a limit. Everything else answers null, so the road stays "unknown" rather than getting
-- a confident wrong number (design §13.2): no km/h conversion, no statutory default (R17), no
-- choice among a `;`-list, no conditional or variable value.
--
-- Run by tests/run.sh inside one transaction that is rolled back; the function under test is
-- loaded from sql/parse_maxspeed.sql first, in the same transaction.
select plan(69);

-- the function exists where the pipeline expects it, is immutable (so the transform can call it per
-- row with no cost surprise) and strict on nulls
select has_function('osm', 'parse_maxspeed_mph', array['text'], 'osm.parse_maxspeed_mph(text) exists');
select volatility_is('osm', 'parse_maxspeed_mph', array['text'], 'immutable', 'the parser is immutable');
select function_returns('osm', 'parse_maxspeed_mph', array['text'], 'smallint', 'the parser returns smallint, the column type');

-- explicit mph
select is(osm.parse_maxspeed_mph('45 mph'), 45::smallint, '"45 mph" is 45');
select is(osm.parse_maxspeed_mph('45mph'), 45::smallint, '"45mph" is 45');
select is(osm.parse_maxspeed_mph('25 MPH'), 25::smallint, 'the unit is case-insensitive');
select is(osm.parse_maxspeed_mph('  35 mph  '), 35::smallint, 'surrounding whitespace is ignored');
select is(osm.parse_maxspeed_mph('5 mph'), 5::smallint, '"5 mph" is the lowest limit kept');
select is(osm.parse_maxspeed_mph('85 mph'), 85::smallint, '"85 mph" is the highest limit kept');
select is(osm.parse_maxspeed_mph('22 mph'), 22::smallint, 'an explicit mph value need not be a multiple of 5');
select is(osm.parse_maxspeed_mph('90 mph'), null::smallint, 'an mph value above 85 is null');
select is(osm.parse_maxspeed_mph('3 mph'), null::smallint, 'an mph value below 5 is null');
select is(osm.parse_maxspeed_mph('0 mph'), null::smallint, '"0 mph" is null');
select is(osm.parse_maxspeed_mph('45.5 mph'), null::smallint, 'a decimal mph value is null');
select is(osm.parse_maxspeed_mph('mph'), null::smallint, 'a unit without a number is null');

-- bare integers: US posted limits are multiples of 5
select is(osm.parse_maxspeed_mph('45'), 45::smallint, 'a bare 45 is 45 mph');
select is(osm.parse_maxspeed_mph('5'), 5::smallint, 'a bare 5 is 5 mph');
select is(osm.parse_maxspeed_mph('85'), 85::smallint, 'a bare 85 is 85 mph');
select is(osm.parse_maxspeed_mph('42'), null::smallint, 'a bare integer that is not a multiple of 5 is null');
select is(osm.parse_maxspeed_mph('90'), null::smallint, 'a bare 90 (out of range) is null');
select is(osm.parse_maxspeed_mph('100'), null::smallint, 'a bare 100 (a km/h value) is null');
select is(osm.parse_maxspeed_mph('0'), null::smallint, 'a bare 0 is null');
select is(osm.parse_maxspeed_mph('045'), null::smallint, 'a leading zero is not a posted limit');
select is(osm.parse_maxspeed_mph('-45'), null::smallint, 'a negative value is null');

-- km/h and other units are never converted
select is(osm.parse_maxspeed_mph('50 km/h'), null::smallint, '"50 km/h" is null');
select is(osm.parse_maxspeed_mph('50km/h'), null::smallint, '"50km/h" is null');
select is(osm.parse_maxspeed_mph('50 kmh'), null::smallint, '"50 kmh" is null');
select is(osm.parse_maxspeed_mph('50 kph'), null::smallint, '"50 kph" is null');
select is(osm.parse_maxspeed_mph('10 knots'), null::smallint, 'knots are null');

-- symbolic values and statutory defaults are not derived (R17)
select is(osm.parse_maxspeed_mph('none'), null::smallint, '"none" is null');
select is(osm.parse_maxspeed_mph('signals'), null::smallint, '"signals" is null');
select is(osm.parse_maxspeed_mph('walk'), null::smallint, '"walk" is null');
select is(osm.parse_maxspeed_mph('US:urban'), null::smallint, '"US:urban" is null');
select is(osm.parse_maxspeed_mph('US:rural'), null::smallint, '"US:rural" is null');
select is(osm.parse_maxspeed_mph('US:WA:residential'), null::smallint, 'a state statutory default is null');
select is(osm.parse_maxspeed_mph('variable'), null::smallint, '"variable" is null');

-- lists and conditional values: the road has more than one limit, so none is chosen
select is(osm.parse_maxspeed_mph('35 mph;45 mph'), null::smallint, 'a ;-list of mph values is null');
select is(osm.parse_maxspeed_mph('35;45'), null::smallint, 'a ;-list of bare values is null');
select is(osm.parse_maxspeed_mph('45 mph;'), null::smallint, 'a trailing ; is still a list');
select is(osm.parse_maxspeed_mph('20 mph @ (07:00-16:00)'), null::smallint, 'a conditional value is null');
select is(osm.parse_maxspeed_mph('25 mph @ (school)'), null::smallint, 'a school-zone conditional is null');

-- empty and missing
select is(osm.parse_maxspeed_mph(null), null::smallint, 'null is null');
select is(osm.parse_maxspeed_mph(''), null::smallint, 'an empty string is null');
select is(osm.parse_maxspeed_mph('   '), null::smallint, 'whitespace alone is null');

-- ---------------------------------------------------------------------------------------------
-- osm.way_limit_mph(maxspeed, maxspeed:forward, maxspeed:backward, way's northmost latitude,
--                   km/h line or null)
-- ---------------------------------------------------------------------------------------------
select has_function('osm', 'way_limit_mph', array['text', 'text', 'text', 'double precision', 'double precision'],
  'osm.way_limit_mph(text, text, text, float8, float8) exists');
select volatility_is('osm', 'way_limit_mph', array['text', 'text', 'text', 'double precision', 'double precision'],
  'immutable', 'the way-level rule is immutable');

-- the km/h guard: a bare number on a road reaching north of the line is Canadian km/h
select is(osm.way_limit_mph('50', null, null, 49.01, 49), null::smallint, 'a bare 50 on a BC road is null (50 km/h)');
select is(osm.way_limit_mph(E'50	', null, null, 49.01, 49), null::smallint, 'a bare 50 with a trailing tab on a BC road is null');
select is(osm.way_limit_mph(E'50
', null, null, 49.01, 49), null::smallint, 'a bare 50 with a trailing CR LF on a BC road is null');
select is(osm.way_limit_mph(E' 30
', null, null, 49.2, 49), null::smallint, 'a padded bare 30 on a BC road is null');
select is(osm.way_limit_mph('30 mph', null, null, 49.01, 49), 30::smallint, 'an explicit "30 mph" on a road reaching into BC is kept');
select is(osm.way_limit_mph(E'30 MPH	', null, null, 49.01, 49), 30::smallint, 'an explicit mph value is kept whatever its case and padding');
select is(osm.way_limit_mph('60', null, null, 48.99, 49), 60::smallint, 'a bare 60 wholly south of the line is 60 mph');
select is(osm.way_limit_mph('60', null, null, 49, 49), 60::smallint, 'a way that reaches exactly the line is not north of it');
select is(osm.way_limit_mph('50', null, null, 49.5, null), 50::smallint, 'with no km/h line every bare value is kept');
select is(osm.way_limit_mph(E'50	', null, null, 49.5, null), 50::smallint, 'with no km/h line a padded bare value is parsed as usual');
select is(osm.way_limit_mph('50 km/h', null, null, 48, 49), null::smallint, 'km/h stays null south of the line too');
select is(osm.way_limit_mph(null, null, null, 49.5, 49), null::smallint, 'an untagged way is null');

-- directional tags: a road with more than one limit gets none (the parser's ;-list rule)
select is(osm.way_limit_mph('35 mph', '35 mph', null, 47, 49), 35::smallint, 'a forward limit equal to the base keeps the base');
select is(osm.way_limit_mph('35 mph', '35', '35 mph', 47, 49), 35::smallint, 'directional limits equal to the base keep it');
select is(osm.way_limit_mph('35 mph', '45 mph', null, 47, 49), null::smallint, 'a differing forward limit makes the way null');
select is(osm.way_limit_mph('35 mph', null, '25 mph', 47, 49), null::smallint, 'a differing backward limit makes the way null');
select is(osm.way_limit_mph('35 mph', 'none', null, 47, 49), null::smallint, 'an unparseable forward value makes the way null');
select is(osm.way_limit_mph(null, '45 mph', '35 mph', 47, 49), null::smallint, 'directional limits alone are not used');
select is(osm.way_limit_mph('50', '50', null, 49.1, 49), null::smallint, 'a BC way with bare base and forward values is null');
select is(osm.way_limit_mph('30 mph', '30', null, 49.1, 49), null::smallint, 'a BC way whose forward value is a bare number (km/h) is null');
select is(osm.way_limit_mph('45 mph', '', null, 47, 49), null::smallint, 'an empty directional tag is not a matching limit');
select is(osm.way_limit_mph('45 mph', null, null, 47, 49), 45::smallint, 'a plain tagged US way keeps its limit');
select is(osm.way_limit_mph('42', null, null, 47, 49), null::smallint, 'the parser rules still apply (a bare 42 is null)');

select * from finish();

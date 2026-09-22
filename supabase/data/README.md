# Speed-limit road data (`supabase/data`)

This directory holds the reproducible import of open road data into the tables migration `0004_speed_limits.sql` defines:
- `osm.ways`: OpenStreetMap roads in twelve classes, with `maxspeed` parsed to mph.
- `hpms.sections`: FHWA HPMS sections that carry a recorded posted limit.

The `speed-limits` edge function serves both through `speed_limit_tiles` and `speed_limit_candidates` (design §4.2, §4.6).

Only the scripts, SQL, Dockerfile, tests and this README are committed. Downloads go to `downloads/`, which is gitignored. Never commit them.

| File | What it does |
|---|---|
| `Dockerfile` | The toolbox image: GDAL 3.11 (`ogr2ogr`), `osmium`, `psql`. |
| `download.sh` | Downloads the Geofabrik OSM extract and the HPMS national File Geodatabase, then extracts one state's sections that have a limit. |
| `import-osm.sh` | Filters to the twelve classes with `osmium tags-filter`, stages with `ogr2ogr`, then runs `transform.sql` into `osm.ways`. |
| `import-hpms.sh` | Stages the state's HPMS extract with `ogr2ogr`, then runs `transform.sql` into `hpms.sections`. |
| `sql/stage.sql` | Creates an empty `roadwise_stage` schema for one run. No API role can use it. |
| `sql/parse_maxspeed.sql` | `osm.parse_maxspeed_mph(text)`, used only by the pipeline. |
| `sql/transform.sql` | Moves staged rows into the real tables in one transaction and drops anything 0004's CHECKs or the device's tile schema would refuse. |
| `sql/postprocess.sql` | Drops the staging schema, then runs `CLUSTER` along the GiST indexes and `ANALYZE`. |
| `sql/size_report.sql` | Reports sizes, row counts, the limit share by class, and the data's extent. It is read-only. |
| `tests/run.sh` | Runs `tests/*.test.sql` (pgTAP) in a transaction that is rolled back. |

Every script re-runs itself inside the `roadwise-data` image when `osmium` is not installed on the host. You therefore need only Docker, plus the local Supabase stack for a local load. The scripts work from Git Bash on Windows as well as on macOS and Linux.

## Sources and licences

- **OpenStreetMap:** Geofabrik's daily extract, `https://download.geofabrik.de/<REGION>-latest.osm.pbf`.
  - © OpenStreetMap contributors, under the Open Database License 1.0 (https://www.openstreetmap.org/copyright).
  - The app must show the attribution (the About screen, design §4.6).
  - The loaded `osm.ways` table is a derivative database of OSM. Its public use, including serving its lines to devices as tiles, is subject to the ODbL's attribution and share-alike terms.
- **HPMS:** FHWA's Highway Performance Monitoring System, 2024 release (data as of 2024-12-31).
  - BTS publishes it in the National Transportation Atlas Database as one File Geodatabase zip (`HPMS2024.zip`, 2.6 GB), with one feature class per state (`HPMS_FULL_<ST>_2024`).
  - Endpoint (confirmed 2026-09-22): `https://www.arcgis.com/sharing/rest/content/items/5e6a977c2d7c4ec1bdc82e684d3384f2/data`. The landing page is https://geodata.bts.gov/datasets/5e6a977c2d7c4ec1bdc82e684d3384f2.
  - Licence: a work of the U.S. Government (17 U.S.C. § 105), available for unrestricted public use. The requested acknowledgement is "Federal Highway Administration (FHWA) and Bureau of Transportation Statistics (BTS)".
  - Two other routes do not work. FHWA's per-state feature services on `geo.dot.gov` (`Hosted/HPMS_FULL_WA_2024`) appear in the server directory but answer 404. No SODA dataset (the design's first idea) carries HPMS geometry. The national zip is therefore the source.

## Local run (Washington)

The steps below assume the local stack is running (`npx supabase start`). If the stack is shared, check first that you hold it (see `.agent` standing instructions).

```sh
docker build -t roadwise-data supabase/data     # once
supabase/data/tests/run.sh                      # parser tests (rolled back, leaves nothing)
supabase/data/download.sh                       # ~3 GB into supabase/data/downloads/
supabase/data/import-osm.sh
supabase/data/import-hpms.sh
```

By default the scripts target the local database, `postgresql://postgres:postgres@127.0.0.1:54622/postgres` (`supabase/config.toml` `[db] port`). Set `DB_URL` to target another database. Inside the container, `127.0.0.1` and `localhost` are rewritten to `host.docker.internal`.

- **Wiping and restoring.** `import-osm.sh` replaces all of `osm.ways` by default (`REPLACE=1`). On a local stack that also removes `seed.sql`'s synthetic fixture. `npx supabase db reset` restores the clean fixture state, and `supabase test db` expects that state.
- **Re-runs are safe.** Each import is one transaction, so a failed run leaves the tables as they were.
- **A failed run leaves `roadwise_stage` behind.** The next run's `stage.sql` clears it, or run `drop schema roadwise_stage cascade`.

Measured on 2026-09-22 (Geofabrik extract of that day, HPMS 2024):
- **OSM:** 335,717 ways, 120,821 of them with a limit (36 %). The run took about 90 s: 16 s osmium, 64 s ogr2ogr, 5 s transform, 2 s postprocess.
- **HPMS:** 82,107 sections, all with a limit. The run took about 5 s.
- **Size:** `osm.ways` is 133 MB and `hpms.sections` 18 MB, **151 MB** of road data in total.

## What the transform decides

**`maxspeed` parsing** (`osm.parse_maxspeed_mph`, tested in `tests/parse_maxspeed.test.sql`):
- `'45 mph'` and `'45mph'` become 45 (the unit is case-insensitive, with at most one space).
- A bare integer that is a multiple of 5 in 5..85 is read as mph.
- Everything else is null: `none`, `signals`, `walk`, `US:*`, `;`-lists, conditional values, km/h, kph and knots, decimals, leading zeros, and anything outside 5..85.
- Statutory defaults are never derived (R17). An untagged road stays "unknown".

**Canadian roads.** A Geofabrik extract keeps every way that crosses its edge whole, so Washington's extract carries about 700 British Columbia roads. In Canada a bare `maxspeed=50` means 50 km/h.
- `KMH_NORTH_OF` names the latitude north of which roads are Canadian. It defaults to 49 for the Washington region, because the state's border with BC is the 49th parallel along its whole length.
- A bare-number limit on any way that reaches north of that line is dropped. The road stays, with no limit.
- An explicit `… mph` value is kept.
- In the Washington run, this dropped 192 limits that would otherwise have been read as mph.

**`oneway`** becomes -1/0/1:
- `yes`, `true` and `1` become 1.
- `-1` and `reverse` become -1.
- Any other value becomes 0, including `no`, `reversible` and `alternating`.
- When the tag is absent, OSM's implied one-way applies: `motorway` and `junction=roundabout|circular` are 1. Every other untagged road is 0.

**HPMS section ids** are the state's FIPS code × 10¹⁰ + the feature's `OBJECTID`; Washington's run from `530000004273` upward. Each id has at most 12 digits, is unique across states, and is stable within one HPMS release. Only rows with `speed_limit` in 5..85 are loaded. The extract already applies `speed_limit IS NOT NULL AND speed_limit < 999`.

## Other states, or the whole US

Other states:

```sh
REGION=north-america/us/oregon STATE=OR supabase/data/download.sh
REGION=north-america/us/oregon REPLACE=0 KMH_NORTH_OF= supabase/data/import-osm.sh
STATE=OR STATE_CODE=41 supabase/data/import-hpms.sh
```

- Use `REPLACE=0` for OSM whenever other states are already loaded. It upserts by way id, so a way that sits in two neighbouring extracts is stored once.
- HPMS replaces only the named state's sections (`REPLACE=1`, the default).
- `STATE_CODE` is the state's FIPS code, and the import refuses an extract whose rows carry a different one.
- The HPMS zip is downloaded once and reused for every state.
- For another state on the Canadian border, set `KMH_NORTH_OF` to a latitude that separates its roads from Canada's, or clip the extract first. For a state on the Mexican border, clip to the US. Not every border is a single parallel.

The whole US:
- Use Geofabrik's `REGION=north-america/us`, then run `import-hpms.sh` once per state.
- It is roughly 50 times Washington, so expect several GB in the database.
- It needs Supabase **Pro** (the free plan's database is 500 MB) and a clip at both national borders in place of `KMH_NORTH_OF`.

After loading more states:
- Update the edge function's `AWS_COVERAGE` box list (`supabase/functions/speed-limits/handler.ts`) to the states actually loaded. `size_report.sql` prints the loaded extent.

## Loading the hosted project: a user action

**Loading the hosted project is not something the pipeline or any agent does.** The project owner decides, based on the measured size.

1. Run the local import and read `size_report.sql`. The plan's gate (R6):
   - If a state's road data is over 400 MB, do not load it on the free plan.
   - Washington is 151 MB, about 30 % of the free plan's 500 MB, before any user data.
2. Confirm the remote runs Postgres 17 and has 0004 applied (backend conventions, item 14).
3. Import with the project's direct connection string (Settings → Database; use the session pooler or direct host, not the transaction pooler):

   ```sh
   DB_URL='postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres' supabase/data/import-osm.sh
   DB_URL='postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres' supabase/data/import-hpms.sh
   ```

   - The import holds locks while it replaces the tables, and `CLUSTER` holds an exclusive lock for a few seconds per table. Run it when no drive depends on the tables.
4. Check the result with `psql "$DB_URL" -f supabase/data/sql/size_report.sql`.

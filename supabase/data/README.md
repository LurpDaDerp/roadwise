# Speed-limit road data (`supabase/data`)

This directory holds the reproducible import of open road data into the tables migration `0004_speed_limits.sql` defines:
- `osm.ways`: OpenStreetMap roads in twelve classes, with `maxspeed` parsed to mph.
- `hpms.sections`: FHWA HPMS sections that carry a recorded posted limit.

The `speed-limits` edge function serves both through `speed_limit_tiles` and `speed_limit_candidates` (design §4.2, §4.6).

Only the scripts, SQL, Dockerfile, tests and this README are committed. Downloads go to `downloads/`, which is gitignored. Never commit them.

| File | What it does |
|---|---|
| `Dockerfile` | The toolbox image: GDAL 3.11 (`ogr2ogr`, base pinned by digest), `osmium` 1.16 (pinned), `psql`. |
| `download.sh` | Downloads the Geofabrik OSM extract and the HPMS national File Geodatabase over https only, verifies both (Geofabrik's md5, the pinned HPMS sha256), then extracts one state's sections that have a limit. |
| `import-osm.sh` | Filters to the twelve classes with `osmium tags-filter`, stages with `ogr2ogr`, then runs `transform.sql` into `osm.ways`. |
| `import-hpms.sh` | Stages the state's HPMS extract with `ogr2ogr`, then runs `transform.sql` into `hpms.sections`. |
| `sql/stage.sql` | Creates an empty `roadwise_stage` schema for one run. No API role can use it. |
| `sql/parse_maxspeed.sql` | `osm.parse_maxspeed_mph(text)`, and `osm.way_limit_mph(...)`, which adds the km/h guard and the directional-tag rule. Used only by the pipeline. |
| `sql/transform.sql` | Moves staged rows into the real tables in one transaction and drops anything 0004's CHECKs or the device's tile schema would refuse. |
| `sql/postprocess.sql` | Drops the staging schema, then runs `CLUSTER` along the GiST indexes (skipped with `CLUSTER=0`) and `ANALYZE`. |
| `sql/size_report.sql` | Reports sizes, row counts, the limit share by class, and the data's extent. It is read-only. |
| `tests/run.sh` | Runs `tests/*.test.sql` (pgTAP) in a transaction that is rolled back. |

Every script re-runs itself inside the `roadwise-data` image when `osmium` is not installed on the host. You therefore need only Docker, plus the local Supabase stack for a local load. The scripts work from Git Bash on Windows as well as on macOS and Linux. (Run natively, they also need `python3`, `curl`, `ogr2ogr` and `psql`.)

## Integrity and credentials

- **Downloads are https-only**, redirects included (`curl --proto =https --proto-redir =https`).
- **Nothing unverified is used.** A tampered extract would put confident wrong limits in front of drivers.
  - HPMS 2024 is a fixed release. Its sha256 (`129b868c…c83f`, taken from the 2026-09-22 download, since BTS publishes no checksum) is pinned in `download.sh` and checked on every run. Another release needs `HPMS_YEAR`, `HPMS_ITEM` and `HPMS_SHA256` together.
  - The OSM extract changes daily, so `download.sh` fetches Geofabrik's published `.md5` with it, keeps it beside the file, and checks it on every run.
- **The toolbox is pinned**: the GDAL base image by digest, osmium to the Ubuntu 24.04 release build.
- **`DB_URL` never appears on a command line.** On the host it is written to a private temporary file, mounted read-only into the container and removed afterwards. Inside, it becomes libpq's `PG*` environment variables, so `psql` and `ogr2ogr` get no connection string in their arguments, in `ps`, or in `docker inspect`. Only `sslmode`, `sslrootcert`, `connect_timeout` and `application_name` are accepted as URL parameters.
- **A database that is not on this machine must be asked for TLS.** The scripts refuse a `DB_URL` whose host is not `localhost`, `127.0.0.1`, `::1` or `host.docker.internal` unless it carries `sslmode=verify-full`, `verify-ca` or `require`. Prefer `verify-full` with the provider's CA certificate (see "Loading the hosted project").

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

Measured on 2026-09-22 (Geofabrik extract with OSM data as of 2026-09-21T20:21:51Z, HPMS 2024):
- **OSM:** 335,717 ways, 120,815 of them with a limit (36 %). The run took 90–130 s: about 15 s osmium, 60–100 s ogr2ogr, 5–15 s transform, 2 s postprocess.
- **HPMS:** 82,107 sections, all with a limit. The run took about 5 s.
- **Size:** `osm.ways` is 133 MB and `hpms.sections` 18 MB, **151 MB** of road data in total.

**Reproducibility is at the procedure level.** Geofabrik's `-latest` extract changes daily and its dated extracts are short-lived, so a given load can be reproduced only from its kept `downloads/` plus `downloads/SOURCES-<ST>.txt`. That file records each input's sha256, size and download (or extraction) time, the checksums it was verified against, and the extract's OSM replication timestamp; `import-osm.sh` also prints that timestamp.

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
- The guard normalises the value exactly as the parser does (the same trim of spaces, tabs, CR and LF; the same case), so no padding lets a bare number past it. It is tested with the parser.

**Directional tags.** `maxspeed:forward` and `maxspeed:backward` are read only to check the base value.
- A way whose directional tag is present and does not give the same limit as its `maxspeed` has more than one limit, so it gets none, the same rule as for `;`-lists. That affected 6 Washington ways.
- A way tagged only directionally stays unknown.
- `maxspeed:conditional` (school zones, times of day) is ignored: the unconditional value is served, which is the posted limit outside the condition.

**`oneway`** becomes -1/0/1:
- `yes`, `true` and `1` become 1.
- `-1` and `reverse` become -1.
- Any other value becomes 0, including `no`, `reversible` and `alternating`.
- When the tag is absent, OSM's implied one-way applies: `motorway` and `junction=roundabout|circular` are 1. Every other untagged road is 0.

**HPMS section ids** are the state's FIPS code × 10¹⁰ + the feature's `OBJECTID`; Washington's run from `530000004273` upward. Each id has at most 12 digits, is unique across states, and is stable within one HPMS release. Only rows with `speed_limit` in 5..85 are loaded. The extract already applies `speed_limit IS NOT NULL AND speed_limit < 999`. `STATE_CODE` must be 1..78 (0004's CHECK).

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
- **A new HPMS release** (2025 and later) renumbers `OBJECTID`, so load it as a full-state replace (`REPLACE=1`) of every state. Phones hold tiles for up to 30 days, so for up to a month their cached HPMS ids differ from the server's. That only changes how an exact tie between equal candidates is broken, never a limit.
- For another state on the Canadian border, set `KMH_NORTH_OF` to a latitude that separates its roads from Canada's, or clip the extract first. For a state on the Mexican border, clip to the US. Not every border is a single parallel.

The whole US:
- Use Geofabrik's `REGION=north-america/us`, then run `import-hpms.sh` once per state.
- It is roughly 50 times Washington, so expect several GB in the database.
- It needs Supabase **Pro** (the free plan's database is 500 MB) and a clip at both national borders in place of `KMH_NORTH_OF`.

After loading more states:
- Update the edge function's `AWS_COVERAGE` box list (`supabase/functions/speed-limits/handler.ts`) to the states actually loaded. `size_report.sql` prints the loaded extent.

## Loading the hosted project: a user action

**Loading the hosted project is not something the pipeline or any agent does.** The project owner decides, based on the measured size.

1. Run the local import and read `size_report.sql`. The plan's gate (R6) has two parts:
   - **Resting size:** a state's road data must be at most 400 MB.
   - **Peak during the load:** a `REPLACE=1` import keeps the old table until it commits, and `CLUSTER` writes a new copy of each table before dropping the old one. Budget about **2 × the road data + the database's current size**, plus WAL, and keep it under the plan's limit. Supabase makes a project read-only when it crosses its size limit.
   - Washington is 151 MB at rest, about 30 % of the free plan's 500 MB, and peaks near 300 MB plus whatever the project already holds.
   - On a tight project, run with `CLUSTER=0`. The GiST index alone answers every query correctly; clustering only makes tile reads more contiguous.
2. Confirm the remote runs Postgres 17 and has 0004 applied (backend conventions, item 14).
3. Download the project's CA certificate (Settings → Database → SSL configuration) into `supabase/data/downloads/` (gitignored), so the container can read it at the same relative path.
4. Put the connection string in the environment without typing it on a command line or into shell history, then import. Use the project's direct or session-pooler connection string (Settings → Database), not the transaction pooler, and ask for TLS verification:

   ```sh
   read -rs DB_URL    # paste: postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=downloads/prod-ca-2021.crt
   export DB_URL
   supabase/data/import-osm.sh
   supabase/data/import-hpms.sh      # prefix both with CLUSTER=0 on a tight project
   unset DB_URL
   ```

   - `sslrootcert` is relative to `supabase/data`, where the scripts run. `sslmode=require` also passes the check but does not verify the server's identity.
   - The scripts refuse a remote `DB_URL` without `sslmode=verify-full`, `verify-ca` or `require`.
   - The import holds locks while it replaces the tables, and `CLUSTER` holds an exclusive lock for a few seconds per table. Run it when no drive depends on the tables.
5. Check the result by running `size_report.sql` in the dashboard's SQL editor, or with `psql` and the same TLS settings.

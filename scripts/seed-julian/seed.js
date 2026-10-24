#!/usr/bin/env node
'use strict';
/**
 * Seeds the demo accounts for the Congressional App Challenge video: "julian", the main demo driver
 * with 89 days of drives on real Seattle roads, and seven more drivers who make the friends screens
 * real (five friends, one pending request each way).
 *
 *   node scripts/seed-julian/seed.js --dry                      build everything and print what the app would show; touches nothing
 *   node scripts/seed-julian/seed.js --local                    seed the local Supabase stack
 *   node scripts/seed-julian/seed.js --linked                   seed the linked (hosted) project
 *   node scripts/seed-julian/seed.js --linked --replace         start over: delete the demo accounts first, then seed
 *   node scripts/seed-julian/seed.js --linked --remove          delete the demo accounts and nothing else
 *   node scripts/seed-julian/seed.js --linked --remove --restore-test-name   ... and give julian_test back its old name
 *
 * Only raw drives are written. Every drive goes through the path a phone upload takes: a v5 upload
 * validated against the upload contract and the integrity rules, stored as finalize-trip stores it
 * (`keepDashcamEvents`, `classifyDrive`) through `private.drive_context` + `private.apply_drive`,
 * oldest first. So the Safety Rating, the weekly goals and the achievements are the server's own
 * derivations, and the category scores, drive scores, merit tiers, trends and problem spots are the
 * app's, computed on the phone from the restored drives. Nothing derived is written by hand.
 *
 * What else it does, and only this:
 *   * the existing "julian" account (the author's test account) is renamed "julian_test", so the demo
 *     can have the name (an UPDATE of that one profile's username, undone with --restore-test-name)
 *   * signs the demo drivers up (e-mail and password, as the app does) and onboards them through the app's
 *     own RPCs (claim_username, complete_onboarding, update_profile)
 *   * friendships and the two pending requests are inserted directly, dated across the last months
 *   * one drive of Julian's as a passenger is marked "Wasn't driving", and two events on drives of
 *     the last week are reported (a hazard brake, a phone that was mounted), through the same private
 *     functions the trip-actions function calls
 *   * every demo account is identified by its e-mail in DEMO_EMAILS; --remove and --replace touch
 *     nothing else
 *
 * `private.*` is not on the Data API, so SQL goes through `supabase db query` (the CLI must be logged
 * in and, for --linked, linked to the project). Accounts are made with the app's own e-mail sign-up and
 * the publishable key every phone carries; no secret key is read.
 */
require('./tshook.js');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const scoring = require('../../packages/scoring/src/index.ts');
const { parseFinalizeUpload } = require('../../src/data/sync/payload.ts');
const { integrityReason } = require(path.join(__dirname, '..', '..', 'supabase', 'functions', '_shared', 'finalize_rules.ts'));
const { buildAll } = require('./build.js');
const { JULIAN, FRIENDS, PENDING } = require('./people.js');

const ROOT = path.resolve(__dirname, '..', '..');
const TERMS_VERSION = '2026-10-05';
const TEST_NAME = 'julian_test';
const ALL = [JULIAN, ...FRIENDS, ...PENDING];
const DEMO_EMAILS = ALL.map((p) => p.email);

// ---------------------------------------------------------------------------------------------
// The database

function cliTarget(flag) {
  if (flag === '--local') {
    return { flag, label: 'local', url: 'http://127.0.0.1:54621', ref: null };
  }
  const linkedFile = path.join(ROOT, 'supabase', '.temp', 'project-ref');
  const ref = fs.existsSync(linkedFile) ? fs.readFileSync(linkedFile, 'utf8').trim() : null;
  if (!ref) throw new Error('the CLI is not linked to a project: run `npx supabase link` first');
  return { flag, label: `linked project ${ref}`, url: `https://${ref}.supabase.co`, ref };
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const quote = (a) => (process.platform === 'win32' && /\s/.test(a) ? `"${a}"` : a);

/** The JSON in what a CLI command printed (status lines may surround it), or null. */
function parseJson(out) {
  const starts = ['[', '{'].map((c) => out.indexOf(c)).filter((i) => i >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const end = out.lastIndexOf(out[start] === '[' ? ']' : '}');
  if (end < start) return null;
  try {
    return JSON.parse(out.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Runs one SQL file through `supabase db query` and returns its rows (a DO block answers none). */
function runSql(target, sql, { rows: wantRows = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-julian-'));
  const file = path.join(dir, 'q.sql');
  fs.writeFileSync(file, sql, 'utf8');
  const args = ['supabase', 'db', 'query', target.flag, '--yes', '-f', file, '--output-format', 'json'].map(quote);
  const r = spawnSync(npx, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 256 * 1024 * 1024 });
  fs.rmSync(dir, { recursive: true, force: true });
  const out = r.stdout ?? '';
  const parsed = parseJson(out);
  const printed = () => `${out}\n${r.stderr ?? ''}`.trim() || String(r.error ?? 'no output');
  const rows = Array.isArray(parsed) ? parsed : parsed?.rows;
  if (r.status === 0 && !wantRows && parsed?._tag !== 'Error') return [];
  if (r.status !== 0 || parsed === null || parsed?._tag === 'Error' || parsed?.error) {
    throw new Error(`supabase db query (${target.flag}) failed: ${parsed?.error?.message ?? printed()}`);
  }
  if (wantRows && !Array.isArray(rows)) throw new Error(`supabase db query (${target.flag}) returned no rows:\n${printed()}`);
  return (rows ?? []).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' && /^[[{]/.test(v) ? safeParse(v) : v])));
}

const safeParse = (v) => {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/** The project's publishable key, from the CLI: the one every phone is built with. No secret key is read or needed. */
function readKeys(target) {
  const args = (target.flag === '--local' ? ['supabase', 'status', '-o', 'json'] : ['supabase', 'projects', 'api-keys', '--project-ref', target.ref, '-o', 'json']).map(quote);
  const r = spawnSync(npx, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  const parsed = parseJson(r.stdout ?? '');
  if (parsed === null) throw new Error(`could not read the project keys from the CLI:\n${r.stdout}\n${r.stderr}`);
  if (target.flag === '--local') return { publishable: parsed.PUBLISHABLE_KEY ?? parsed.ANON_KEY };
  const publishable = parsed.find((k) => k.type === 'publishable')?.api_key;
  if (!publishable) throw new Error('the project has no publishable key');
  return { publishable };
}

/** A JSON value as a dollar-quoted SQL literal. */
function jsonLiteral(value) {
  const text = JSON.stringify(value);
  if (text.includes('$j$')) throw new Error('a JSON value holds the $j$ quote');
  return `$j$${text}$j$::jsonb`;
}

const uuidLiteral = (id) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error(`not a uuid: ${id}`);
  return `'${id}'::uuid`;
};

const emailList = (list) => list.map((e) => `'${e.replace(/'/g, "''")}'`).join(', ');

// ---------------------------------------------------------------------------------------------
// The upload and what finalize-trip stores of it

/** Why finalize-trip would not take an upload as a fresh drive (null: it would): the v5 contract and the integrity rules. */
function uploadProblem(p) {
  const parsed = parseFinalizeUpload(p);
  if (!parsed.success) return `breaks the upload contract: ${parsed.error.message}`;
  if (p.v !== 5) return 'is not a v5 upload';
  const refused = integrityReason(p);
  if (refused) return `would be stored unscored as ${refused}`;
  return null;
}

/** The `private.apply_drive` envelope finalize-trip would build (its handler.ts). */
function toEnvelope(userId, p, stored) {
  const { kept, dashcam, scored, reason } = stored;
  return {
    user: userId,
    mergeInto: null,
    dashcam,
    payload: {
      clientTripId: p.clientTripId,
      startedAt: p.startedAt,
      endedAt: p.endedAt,
      tz: p.tz,
      localDay: p.localDay,
      miles: p.miles,
      nightMiles: p.nightMiles,
      durationS: Math.round(p.durationS),
      end: p.end,
      polyline: p.polyline,
      appVersion: p.appVersion,
      dashcam: p.dashcam ?? null,
      origin: p.origin,
      notDrivingExpired: p.notDrivingExpired,
      exposure: p.exposure ? scoring.clampExposure(p.exposure) : null,
    },
    scored,
    reason,
    events: kept.map((e) => ({
      id: e.id,
      type: e.type,
      tier: e.tier,
      startedAt: e.startedAt,
      durationS: e.durationS,
      zone: e.zone ?? null,
      status: 'active',
      lat: e.lat,
      lng: e.lng,
      measured: e.measured,
    })),
    scoringVersion: scoring.SCORING_VERSION,
  };
}

const contextCall = (userId, p) =>
  `private.drive_context(${uuidLiteral(userId)}, ${uuidLiteral(p.clientTripId)}, to_timestamp(${p.startedAt} / 1000.0), '${p.localDay}'::date, ` +
  `${p.start.lat}, ${p.start.lng}, to_timestamp(${p.endedAt} / 1000.0))`;

/** One batch of drives as one statement: each must meet a server context of version 23 and phone use, nothing stored, no merge; then apply_drive stores it. */
function batchSql(userId, items) {
  const lines = items.map(({ payload, envelope }) =>
    [
      `  c := ${contextCall(userId, payload)};`,
      `  if c -> 'version' <> '23'::jsonb or c -> 'phoneUse' <> 'true'::jsonb or c -> 'existing' <> 'null'::jsonb or c -> 'merge' <> 'null'::jsonb then`,
      `    raise exception 'seed-julian: the server context for drive ${payload.clientTripId} is %, not a fresh drive', c;`,
      '  end if;',
      `  perform private.apply_drive(${jsonLiteral(envelope)});`,
    ].join('\n')
  );
  return `do $seed$\ndeclare c jsonb;\nbegin\n${lines.join('\n')}\nend $seed$`;
}

// ---------------------------------------------------------------------------------------------
// Passwords

/** Julian's password: the same on every run, so a re-seed does not lock the demo out. */
const JULIAN_PASSWORD = 'test1234';

/** A friend's password: nobody signs in as a friend, so it is 256 random bits and is not kept. */
const secretPassword = () => crypto.randomBytes(32).toString('base64url');

// ---------------------------------------------------------------------------------------------
// Steps

function preflight(target) {
  const [row] = runSql(
    target,
    `select
       (select max(version) from supabase_migrations.schema_migrations) as migration,
       (select count(*)::int from auth.users where lower(email) in (${emailList(DEMO_EMAILS)})) as accounts,
       (select count(*)::int from public.profiles where username::text in (${ALL.filter((p) => p.key !== 'julian').map((p) => `'${p.username}'`).join(', ')}) and id not in (select id from auth.users where lower(email) in (${emailList(DEMO_EMAILS)}))) as names_taken,
       (select count(*)::int from public.challenge_templates) as templates`
  );
  return row;
}

function renameTestAccount(target) {
  const found = runSql(
    target,
    `select p.id, p.username::text as username, u.email, p.onboarded_at is not null as onboarded
       from public.profiles p join auth.users u on u.id = p.id
      where p.username::text = '${JULIAN.username}' and lower(u.email) <> '${JULIAN.email}'`,
    { rows: true }
  );
  if (found.length === 0) return null;
  if (found.length > 1) throw new Error('more than one account is named julian');
  const [old] = found;
  const taken = runSql(target, `select count(*)::int as n from public.profiles where username::text = '${TEST_NAME}'`);
  if (taken[0].n > 0) throw new Error(`${TEST_NAME} is already taken`);
  runSql(target, `update public.profiles set username = '${TEST_NAME}' where id = ${uuidLiteral(old.id)} and username::text = '${JULIAN.username}'`, { rows: false });
  const after = runSql(target, `select username::text as username from public.profiles where id = ${uuidLiteral(old.id)}`);
  if (after[0].username !== TEST_NAME) throw new Error('the rename did not take');
  return { id: old.id, email: old.email };
}

function removeAccounts(target) {
  const [{ n }] = runSql(target, `with d as (delete from auth.users where lower(email) in (${emailList(DEMO_EMAILS)}) returning id) select count(*)::int as n from d`);
  return n;
}

const TRANSIENT = /fetch failed|ECONNRESET|ECONNREFUSED|socket|timed? ?out|network|502|503|504/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a network call, trying again (a few times, a little later each) when it fails the way a dropped connection does. */
async function retrying(label, call) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const out = await call();
      if (out?.error && TRANSIENT.test(String(out.error.message ?? ''))) throw new Error(out.error.message);
      return out;
    } catch (err) {
      if (attempt >= 4 || !TRANSIENT.test(String(err?.message ?? err))) throw err;
      await sleep(1500 * attempt);
    }
  }
}

/** Signs a demo driver up the way the app does (e-mail and password, no confirmation) and onboards them through the app's own RPCs. */
async function createAccount(target, url, keys, person, password) {
  const { createClient } = require('@supabase/supabase-js');
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const client = createClient(url, keys.publishable, opts);
  const signedUp = await retrying('sign up', () => client.auth.signUp({ email: person.email, password }));
  if (signedUp.error) throw new Error(`sign up ${person.email}: ${signedUp.error.message}`);
  if (!signedUp.data.session) {
    // the project asks for e-mail confirmation: the demo drivers need none
    throw new Error(`sign up ${person.email}: no session (is e-mail confirmation on?)`);
  }
  const id = signedUp.data.user.id;
  const rpc = async (fn, args) => {
    const { data: out, error: err } = await retrying(fn, () => client.rpc(fn, args));
    if (err) throw new Error(`${fn} (${person.username}): ${err.message}`);
    return out;
  };
  await rpc('claim_username', { p: person.username });
  await rpc('complete_onboarding', { p_terms_version: TERMS_VERSION });
  await rpc('update_profile', {
    p_units: 'mi',
    p_state: person.state,
    p_heatmap_visibility: person.share.heatmap,
    p_share_rating: person.share.rating,
    p_share_categories: person.share.categories,
    p_share_achievements: person.share.achievements,
    p_share_stats: person.share.stats,
  });
  return { id, rpc, client };
}

function storeDrives(target, userId, drives, label) {
  let batch = [];
  let bytes = 0;
  let sent = 0;
  const flush = () => {
    if (batch.length === 0) return;
    runSql(target, batchSql(userId, batch), { rows: false });
    sent += batch.length;
    process.stdout.write(`  ${label}: stored ${sent}/${drives.length} drives\r`);
    batch = [];
    bytes = 0;
  };
  for (const d of drives) {
    const envelope = toEnvelope(userId, d.payload, d.stored);
    batch.push({ payload: d.payload, envelope });
    bytes += JSON.stringify(envelope).length;
    if (batch.length >= (target.flag === '--local' ? 12 : 8) || bytes > 90_000) flush();
  }
  flush();
  process.stdout.write('\n');
}

/** Friendships and the two pending requests, dated across the last months. */
function relate(target, ids) {
  const j = ids.julian;
  const lines = [];
  for (const f of FRIENDS) {
    const f_id = ids[f.key];
    lines.push(
      `insert into public.friendships (user_a, user_b, created_at) values (least(${uuidLiteral(j)}, ${uuidLiteral(f_id)}), greatest(${uuidLiteral(j)}, ${uuidLiteral(f_id)}), now() - interval '${f.friendDaysAgo} days' - interval '${(f.seed % 17) + 2} hours');`
    );
  }
  for (const p of PENDING) {
    const o = ids[p.key];
    if (p.direction === 'incoming') lines.push(`insert into public.friend_requests (from_id, to_id, created_at) values (${uuidLiteral(o)}, ${uuidLiteral(j)}, now() - interval '3 hours');`);
    else lines.push(`insert into public.friend_requests (from_id, to_id, created_at) values (${uuidLiteral(j)}, ${uuidLiteral(o)}, now() - interval '2 days');`);
  }
  runSql(target, `do $rel$\nbegin\n${lines.join('\n')}\nend $rel$`, { rows: false });
}

/** The ride Julian was a passenger on is marked "Wasn't driving"; two events of the last week are reported. */
function afterwards(target, julianId, built, now) {
  const mine = built.drives;
  const notes = [];
  const passenger = mine.find((d) => d.trip.kind === 'passenger');
  if (passenger) {
    const [r] = runSql(target, `select private.mark_not_driving(${uuidLiteral(julianId)}, ${uuidLiteral(passenger.payload.clientTripId)}) as r`);
    notes.push(`marked the passenger drive "Wasn't driving" (${r.r.notDrivingLeft} uses left this month)`);
  }
  const d = built.report.disputable;
  for (const [reason, pick] of [['hazard', d.hazard], ['mounted', d.mounted]]) {
    if (!pick) continue;
    const [r] = runSql(target, `select private.dispute_event(${uuidLiteral(julianId)}, ${uuidLiteral(pick.clientTripId)}, ${uuidLiteral(pick.eventId)}, '${reason}') as r`);
    notes.push(`reported ${pick.type} (${reason}): ${r.r.status}`);
  }
  return notes;
}

// ---------------------------------------------------------------------------------------------
// Checks

/** Pages of list_my_drives, as the phone's restore reads them. */
async function listAllDrives(rpc) {
  const out = [];
  let before = null;
  for (;;) {
    const page = await rpc('list_my_drives', before ? { p_limit: 50, p_before: before } : { p_limit: 50 });
    out.push(...page);
    if (page.length < 50) break;
    before = new Date(Math.min(...page.map((x) => x.startedAt))).toISOString();
  }
  return out;
}

/** The Safety Rating and categories the phone computes from the drives the server lists. */
function ratingFromServer(rows, now) {
  const drives = rows
    .filter((r) => r.scored && !r.notDriving)
    .map((r) => ({
      id: r.clientTripId,
      startedAt: r.startedAt,
      miles: Number(r.miles),
      watchedMiles: scoring.watchedMiles(Number(r.miles), r.dashcamMovingS ?? 0, r.dashcamCoveredS ?? 0),
      exposure: scoring.clampExposure({ ...r.exposure }),
      events: r.events.filter((e) => e.status !== 'removed').map((e) => ({ id: e.id, type: e.type, tier: e.tier, startedAt: e.startedAt, durationS: Number(e.durationS), status: 'active', measured: e.measured })),
    }));
  return scoring.ratingAt(drives, now);
}

async function verify(url, keys, people, passwords, built) {
  const { createClient } = require('@supabase/supabase-js');
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const client = createClient(url, keys.publishable, opts);
  const { error } = await retrying('verify sign in', () => client.auth.signInWithPassword({ email: JULIAN.email, password: passwords.julian }));
  if (error) throw new Error(`verify sign in: ${error.message}`);
  const rpc = async (fn, args) => {
    const { data, error: err } = await retrying(fn, () => client.rpc(fn, args));
    if (err) throw new Error(`${fn}: ${err.message}`);
    return data;
  };
  const problems = [];
  const summary = await rpc('get_my_summary');
  const rows = await listAllDrives(rpc);
  const local = ratingFromServer(rows, Date.now());
  const serverRating = Number(summary.progress.safety_rating);
  if (Math.abs(local.rating - serverRating) > 0.05) problems.push(`the server's Safety Rating ${serverRating} differs from the scoring package's ${local.rating} over the same drives`);
  if (rows.length !== built.drives.length) problems.push(`stored ${built.drives.length} drives but list_my_drives returns ${rows.length}`);
  const friends = await rpc('list_friends');
  const board = await rpc('get_friends_board');
  const profiles = {};
  for (const f of FRIENDS) profiles[f.username] = await rpc('get_profile', { p_username: f.username });
  for (const f of FRIENDS) {
    const pr = profiles[f.username];
    if (pr.relationship !== 'friend') problems.push(`${f.username} is not a friend`);
    if (f.share.categories && !pr.scores) problems.push(`${f.username} shares categories but get_profile shows none`);
    if (!f.share.categories && pr.scores) problems.push(`${f.username} hides categories but get_profile shows them`);
  }
  if (friends.friends.length !== FRIENDS.length || friends.incoming.length !== 1 || friends.outgoing.length !== 1) problems.push('the friend lists are not 5 friends, 1 incoming, 1 outgoing');
  if (board.length !== 1 + FRIENDS.length) problems.push(`the friends board lists ${board.length} drivers`);
  return { summary, rows, local, friends, board, profiles, problems };
}

// ---------------------------------------------------------------------------------------------

function printDry(builds, now) {
  for (const b of builds) {
    const r = b.report;
    console.log(
      `${b.person.username.padEnd(11)} draw ${String(b.draw).padStart(3)}  ${String(r.drives).padStart(3)} drives  ${String(r.miles).padStart(7)} mi  rating ${r.rating} (a week ago ${r.rating7})  ` +
        `${Object.entries(r.axes)
          .map(([k, v]) => `${k.slice(0, 3)} ${v ?? '-'}`)
          .join(' ')}  clean ${r.clean}/${r.scored}`
    );
  }
  const j = builds.find((b) => b.person.key === 'julian');
  if (j) {
    const r = j.report;
    console.log(`\njulian, as the app will show it (now ${new Date(now).toISOString()}):`);
    console.log(`  merits ${JSON.stringify(r.merits)}  events ${JSON.stringify(r.counts)}  night miles ${r.nightMiles}`);
    console.log(`  achievements ${JSON.stringify(r.achievements)}  this week's goals ${JSON.stringify(r.goals)} (${r.thisWeekDrives} drives this week)`);
    console.log(`  problem spots ${r.spots.map((s) => `${s.kind} ${s.state} ${s.hits}/${s.passes}`).join(', ')}`);
    console.log(`  weekly average drive score, oldest week first: ${r.trend.map((t) => t.score).join(' ')}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
  const now = Date.now();

  if (has('--dry')) {
    printDry(buildAll(now, only), now);
    return;
  }
  const flag = has('--local') ? '--local' : has('--linked') ? '--linked' : null;
  if (flag === null) {
    console.error('Pass --dry, --local or --linked (see the header of this file).');
    process.exit(2);
  }
  const target = cliTarget(flag);
  console.log(`Target: ${target.label} (${target.url})`);

  if (has('--remove')) {
    console.log(`  removed ${removeAccounts(target)} demo accounts`);
    if (has('--restore-test-name')) {
      runSql(target, `update public.profiles set username = '${JULIAN.username}' where username::text = '${TEST_NAME}' and not exists (select 1 from public.profiles where username::text = '${JULIAN.username}')`, { rows: false });
      console.log(`  ${TEST_NAME} is julian again (if it was there)`);
    }
    return;
  }

  const pre = preflight(target);
  console.log(`  migrations up to ${pre.migration}; ${pre.accounts} demo accounts already there`);
  if (!(pre.migration >= '0026')) throw new Error('the database needs migration 0026 (phone use) before the demo drives can be stored');
  if (pre.templates !== 3) throw new Error(`expected 3 weekly goal templates, found ${pre.templates}`);
  if (pre.names_taken > 0) throw new Error('one of the demo usernames is taken by an account that is not a demo account');
  if (pre.accounts > 0) {
    if (!has('--replace')) throw new Error('the demo accounts already exist: pass --replace to start over, or --remove to delete them');
    console.log(`  --replace: removed ${removeAccounts(target)} demo accounts`);
  }

  console.log('Building the histories ...');
  const builds = buildAll(now, only);
  printDry(builds, now);
  for (const b of builds) {
    for (const d of b.drives) {
      const problem = uploadProblem(d.payload);
      if (problem) throw new Error(`${b.person.key}: drive ${d.payload.clientTripId} ${problem}`);
    }
  }
  if (only !== null && !only.includes('julian')) throw new Error('--only must include julian when writing');

  const keys = readKeys(target);
  const renamed = renameTestAccount(target);
  if (renamed) console.log(`  renamed the existing "julian" (${renamed.email}) to "${TEST_NAME}"`);

  const ids = {};
  const passwords = {};
  for (const b of builds) {
    const person = b.person;
    passwords[person.key] = person.key === 'julian' ? JULIAN_PASSWORD : secretPassword();
    const account = await createAccount(target, target.url, keys, person, passwords[person.key]);
    ids[person.key] = account.id;
    console.log(`  created @${person.username} (${account.id})`);
    storeDrives(target, account.id, b.drives, person.username);
  }
  relate(target, ids);
  console.log('  friendships and the two pending requests are in');
  const julianBuild = builds.find((b) => b.person.key === 'julian');
  for (const note of afterwards(target, ids.julian, julianBuild, now)) console.log(`  ${note}`);

  const v = await verify(target.url, keys, ALL, passwords, julianBuild);
  const g = v.summary.progress;
  console.log('\nWhat the server now holds for @julian:');
  console.log(`  Safety Rating ${g.safety_rating} (${g.ranked ? 'ranked' : 'unranked'}, ${g.miles_90d} mi in 90 days, ${g.rating_trend >= 0 ? '+' : ''}${g.rating_trend} against a week ago)`);
  console.log(`  the scoring package, over the drives list_my_drives returns: ${v.local.rating}  ${Object.entries(v.local.scores).map(([k, s]) => `${k.slice(0, 3)} ${s === null ? '-' : Math.round(s)}`).join(' ')}`);
  console.log(`  achievements: ${v.summary.achievements.join(', ') || 'none'}`);
  console.log(`  this week's goals: ${v.summary.challenges.map((c) => `${c.title} ${c.progress}/${c.target}${c.completed ? ' done' : ''}`).join('; ')}`);
  console.log(`  "Wasn't driving" marks left this month: ${v.summary.not_driving_left}`);
  console.log(`  friends board: ${v.board.map((r) => `${r.rank}. ${r.username} ${r.value ?? '-'}`).join('  ')}`);
  console.log(`  ${v.rows.length} drives listed`);
  if (v.problems.length > 0) {
    console.error(`\nPROBLEMS:\n  ${v.problems.join('\n  ')}`);
    process.exitCode = 1;
  }
  console.log(`\nSign in to the app with:\n  email     ${JULIAN.email}\n  password  ${passwords.julian}\n  username  @${JULIAN.username}`);
}

module.exports = { uploadProblem, toEnvelope, batchSql, parseJson, ratingFromServer };

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nseed-julian failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

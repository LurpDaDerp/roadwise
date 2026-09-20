import { supabase } from './client';
import type { Database } from './types';

type Tables = Database['public']['Tables'];

export type Profile = Tables['profiles']['Row'];
export type Consent = Tables['consents']['Row'];

// The generated `Update`/`Insert` types describe every column; the column grants in
// 0001_foundation.sql let a client write only these. Postgres rejects the whole statement (42501)
// when any other key is present, so the lists below are the single source of truth for the payload
// shape and the wrappers send nothing outside them. See README.md beside this file.
const PROFILE_PATCH_COLUMNS = [
  'display_name',
  'avatar_path',
  'driving_stage',
  'units',
  'locale',
  'profile_visibility',
  'flags',
] as const;
const CONSENT_INSERT_COLUMNS = ['type', 'version'] as const;

export type ProfilePatch = Pick<Tables['profiles']['Update'], (typeof PROFILE_PATCH_COLUMNS)[number]>;
export type ConsentInsert = Pick<Tables['consents']['Insert'], (typeof CONSENT_INSERT_COLUMNS)[number]>;

/**
 * Copies only `columns` out of `value`. A key that is missing and a key set to `undefined` both
 * mean "leave the column alone" (undefined is not a JSON value), so neither is sent; `null` is a
 * real value (clear the column) and goes through.
 */
function pickColumns<T extends object, K extends keyof T>(value: T, columns: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const column of columns) {
    if (value[column] !== undefined) out[column] = value[column];
  }
  return out;
}

export async function fetchProfile(userId: string): Promise<Profile> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (error) throw error;
  return data;
}

/** The only write path for `profiles`: sends the client-writable columns of `patch`, nothing else. */
export async function updateOwnProfile(userId: string, patch: ProfilePatch): Promise<Profile> {
  const { data, error } = await supabase
    .from('profiles')
    .update(pickColumns(patch, PROFILE_PATCH_COLUMNS))
    .eq('id', userId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

/** The only write path for `consents`: `user_id`, `type` and `version`; the server stamps the rest. */
export async function recordConsent(userId: string, consent: ConsentInsert): Promise<Consent> {
  const { data, error } = await supabase
    .from('consents')
    .insert({ user_id: userId, ...pickColumns(consent, CONSENT_INSERT_COLUMNS) })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

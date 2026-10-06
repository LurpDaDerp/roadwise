import { callRpc } from '@/data/server/rpc';

import { supabase } from './client';
import type { Database } from './types';

type Tables = Database['public']['Tables'];

export type Profile = Tables['profiles']['Row'];
export type Consent = Tables['consents']['Row'];

export type LicenseStage = 'permit' | 'intermediate' | 'full';
export type HeatmapVisibility = 'only_me' | 'clan' | 'friends';

/** What `update_profile` accepts (backend-interface §5). A `null` state clears it. */
export interface ProfilePatch {
  license_stage?: LicenseStage | null;
  units?: 'mi' | 'km';
  state?: string | null;
  heatmap_visibility?: HeatmapVisibility;
}

export interface ConsentInsert {
  /** `terms_13_plus`; the server records the kind, the client only names the version. */
  kind?: string;
  type?: string;
  version: string;
}

/** The owner's own row (RLS: owner-read). */
export async function fetchProfile(userId: string): Promise<Profile> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (error) throw error;
  return data;
}

/** The only write path for `profiles`: the `update_profile` RPC, then the row read back. */
export async function updateOwnProfile(userId: string, patch: ProfilePatch): Promise<Profile> {
  const args: Record<string, unknown> = {};
  if (patch.license_stage !== undefined) args.p_license_stage = patch.license_stage;
  if (patch.units !== undefined) args.p_units = patch.units;
  if (patch.state !== undefined) args.p_state = patch.state ?? '';
  if (patch.heatmap_visibility !== undefined) args.p_heatmap_visibility = patch.heatmap_visibility;
  await callRpc<unknown>('update_profile', args);
  return fetchProfile(userId);
}

/** The only write path for `consents`: `accept_terms(p_version)`, then the latest row read back. */
export async function recordConsent(userId: string, consent: ConsentInsert): Promise<Consent> {
  await callRpc<unknown>('accept_terms', { p_version: consent.version });
  const { data, error } = await supabase
    .from('consents')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (error) throw error;
  return data;
}

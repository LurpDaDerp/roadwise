import { callRpc } from '@/data/server/rpc';

import { supabase } from './client';
import type { Database } from './types';

type Tables = Database['public']['Tables'];

/** `flagged` is moderation state: the server never shows it to its owner. */
export type Profile = Omit<Tables['profiles']['Row'], 'flagged'>;
export type Consent = Tables['consents']['Row'];

export type HeatmapVisibility = 'only_me' | 'friends';

/** What `update_profile` accepts (backend-interface §5). A `null` state clears it; a key left out is unchanged. */
export interface ProfilePatch {
  units?: 'mi' | 'km';
  state?: string | null;
  heatmap_visibility?: HeatmapVisibility;
  /** Friends see the Safety Rating. */
  share_rating?: boolean;
  /** Friends see the category scores. */
  share_categories?: boolean;
  /** Friends see the achievements. */
  share_achievements?: boolean;
  /** Friends see the drives, distance and events. */
  share_stats?: boolean;
}

export interface ConsentInsert {
  /** `terms_13_plus`; the server records the kind, the client only names the version. */
  kind?: string;
  type?: string;
  version: string;
}

/**
 * Every `profiles` column the owner may read (migrations 0001 and 0025 grant them by name).
 * `select('*')` would also name `flagged`, and Postgres then refuses the whole read: nobody could
 * sign in.
 */
export const PROFILE_COLUMNS =
  'id, username, units, state, heatmap_visibility, league_eligible, onboarded_at, created_at, updated_at, share_rating, share_categories, share_achievements, share_stats';

/** The owner's own row (RLS: owner-read). */
export async function fetchProfile(userId: string): Promise<Profile> {
  const { data, error } = await supabase.from('profiles').select(PROFILE_COLUMNS).eq('id', userId).single();
  if (error) throw error;
  return data;
}

/** The only write path for `profiles`: the `update_profile` RPC, then the row read back. */
export async function updateOwnProfile(userId: string, patch: ProfilePatch): Promise<Profile> {
  const args: Record<string, unknown> = {};
  if (patch.units !== undefined) args.p_units = patch.units;
  if (patch.state !== undefined) args.p_state = patch.state ?? '';
  if (patch.heatmap_visibility !== undefined) args.p_heatmap_visibility = patch.heatmap_visibility;
  if (patch.share_rating !== undefined) args.p_share_rating = patch.share_rating;
  if (patch.share_categories !== undefined) args.p_share_categories = patch.share_categories;
  if (patch.share_achievements !== undefined) args.p_share_achievements = patch.share_achievements;
  if (patch.share_stats !== undefined) args.p_share_stats = patch.share_stats;
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

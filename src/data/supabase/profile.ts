import { supabase } from './client';
import type { Database } from './types';

export type Profile = Database['public']['Tables']['profiles']['Row'];

export async function fetchProfile(userId: string): Promise<Profile> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (error) throw error;
  return data;
}

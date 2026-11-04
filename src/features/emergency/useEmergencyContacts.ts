/**
 * The emergency contacts for the screens (Settings, Home's goals, the driving screen's panel):
 * read once and kept in the query cache (a sign-out clears it), saved and removed here.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';

import { readContacts, withContact, writeContacts, type EmergencyContact } from './model';

export const EMERGENCY_CONTACTS_QUERY = ['emergency', 'contacts'] as const;

/** Save `contact` (new, or replacing the one with its id). */
export async function saveContact(settings: SettingsRepo, contact: EmergencyContact): Promise<EmergencyContact[]> {
  await writeContacts(settings, withContact(await readContacts(settings), contact));
  return readContacts(settings);
}

/** Remove the contact `id`. */
export async function removeContact(settings: SettingsRepo, id: string): Promise<EmergencyContact[]> {
  await writeContacts(settings, (await readContacts(settings)).filter((c) => c.id !== id));
  return readContacts(settings);
}

export function useEmergencyContacts() {
  const db = useDb();
  const client = useQueryClient();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const query = useQuery({ queryKey: EMERGENCY_CONTACTS_QUERY, queryFn: () => readContacts(settings) });

  const settle = useCallback(
    (contacts: EmergencyContact[]) => {
      client.setQueryData(EMERGENCY_CONTACTS_QUERY, contacts);
    },
    [client]
  );

  const save = useCallback(
    async (contact: EmergencyContact): Promise<boolean> => {
      try {
        settle(await saveContact(settings, contact));
        return true;
      } catch {
        return false;
      }
    },
    [settings, settle]
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        settle(await removeContact(settings, id));
        return true;
      } catch {
        return false;
      }
    },
    [settings, settle]
  );

  return { contacts: query.data, loading: query.isLoading, refetch: query.refetch, save, remove };
}

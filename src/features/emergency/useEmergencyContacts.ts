/**
 * The emergency contacts for the screens (Settings, Home's card and goals, the driving screen's
 * panel): read once and kept in the query cache (a sign-out clears it), saved and removed here.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';

import {
  EMERGENCY_CARD_DISMISSED_KEY,
  readContacts,
  withContact,
  writeContacts,
  type EmergencyContact,
} from './model';

export const EMERGENCY_CONTACTS_QUERY = ['emergency', 'contacts'] as const;
export const EMERGENCY_CARD_QUERY = ['emergency', 'card'] as const;

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
      void client.invalidateQueries({ queryKey: EMERGENCY_CARD_QUERY });
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

/** Whether Home shows "Add emergency contacts": none saved and the card not closed. */
export async function readEmergencyCard(settings: Pick<SettingsRepo, 'get'>): Promise<boolean> {
  const [contacts, dismissed] = await Promise.all([
    readContacts(settings),
    settings.get<boolean>(EMERGENCY_CARD_DISMISSED_KEY),
  ]);
  return contacts.length === 0 && dismissed !== true;
}

export function useEmergencyCard() {
  const db = useDb();
  const client = useQueryClient();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const query = useQuery({ queryKey: EMERGENCY_CARD_QUERY, queryFn: () => readEmergencyCard(settings) });
  const dismiss = useCallback(() => {
    client.setQueryData(EMERGENCY_CARD_QUERY, false);
    void settings.set(EMERGENCY_CARD_DISMISSED_KEY, true).catch(() => {});
  }, [client, settings]);
  return { show: query.data === true, dismiss, refetch: query.refetch };
}

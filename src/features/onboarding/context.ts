/**
 * The onboarding flow's context, from what the phone already knows (Task 12).
 *
 * `useFlowContext()` replaces Task 11's stub. It reads:
 *   - the band, the stage and `flags.disclaimerAcknowledged` from the session's profile — the
 *     network row, or the cached one after an offline cold start (rev1: I11);
 *   - `legal_urls`, the consent mode and the flags from the cached app config (`useAppConfig`);
 *   - the account's Terms and Privacy consents, only while the documents are published: this
 *     device's copy of the last read at once, the server's when it answers.
 *
 * It never waits on the network (T11 review): the only reads it waits for are local. While the
 * documents are unpublished, `termsCurrent` is the disclaimer acknowledgement alone (rev1: I7,
 * T11 carry), so the Terms step leaves the flow the moment it has been ticked.
 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { Platform } from 'react-native';

import { useAppConfig, type AppConfig } from '@/data/config/appConfig';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { useSession } from '@/data/supabase/session';
import { legalState, type LegalState } from '@/features/auth/legal';
import { hasCurrentTerms, type ConsentRow } from '@/features/auth/pendingConsent';

import { clearBlockPurged, fetchOwnConsents } from './api';
import { asAgeBand, asDrivingStage, type FlowContext } from './flow';

/** Settings key: `{ userId, rows }`, the account's last-read Terms and Privacy consents. */
export const CONSENTS_CACHE_KEY = 'onboarding.consents';

/** The device's copy (local) and the server's answer, per account. */
export const consentsCacheQueryKey = (userId: string) =>
  ['settings', CONSENTS_CACHE_KEY, userId] as const;
export const consentsQueryKey = (userId: string) => ['onboarding', 'consents', userId] as const;

interface StoredConsents {
  userId: string;
  rows: ConsentRow[];
}

const isConsentRow = (v: unknown): v is ConsentRow =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Record<string, unknown>).type === 'string' &&
  typeof (v as Record<string, unknown>).version === 'string';

/** This account's cached consents, or null. Never another account's; never rejects. */
export async function readCachedConsents(
  settings: SettingsRepo,
  userId: string
): Promise<ConsentRow[] | null> {
  try {
    const stored = await settings.get<StoredConsents>(CONSENTS_CACHE_KEY);
    if (!stored || stored.userId !== userId || !Array.isArray(stored.rows)) return null;
    return stored.rows.filter(isConsentRow);
  } catch {
    return null;
  }
}

export async function writeCachedConsents(
  settings: SettingsRepo,
  userId: string,
  rows: readonly ConsentRow[]
): Promise<void> {
  await settings.set(CONSENTS_CACHE_KEY, { userId, rows: [...rows] } satisfies StoredConsents);
}

/**
 * The Terms step has just recorded both documents at the published versions: say so everywhere
 * the flow reads, without another round trip — the query the context holds, and the device's
 * copy for the next offline start.
 */
export async function noteConsentsRecorded(
  client: QueryClient,
  settings: SettingsRepo,
  userId: string,
  legal: LegalState
): Promise<void> {
  if (!legal.tos || !legal.privacy) return;
  const before =
    client.getQueryData<ConsentRow[]>(consentsQueryKey(userId)) ??
    client.getQueryData<ConsentRow[] | null>(consentsCacheQueryKey(userId)) ??
    [];
  const rows: ConsentRow[] = [
    ...before,
    { type: 'tos', version: legal.tos.version, revoked_at: null },
    { type: 'privacy', version: legal.privacy.version, revoked_at: null },
  ];
  client.setQueryData(consentsQueryKey(userId), rows);
  client.setQueryData(consentsCacheQueryKey(userId), rows);
  await writeCachedConsents(settings, userId, rows).catch(() => {});
}

/** The pure part: every input known, the context the flow runs on. */
export function buildFlowContext(input: {
  platform: 'ios' | 'android';
  profile: { age_band?: string | null; driving_stage?: string | null; flags?: unknown };
  config: Pick<AppConfig, 'flags' | 'minor_consent_mode' | 'legal_urls' | 'onboarding'>;
  consents: readonly ConsentRow[];
}): FlowContext {
  const legal = legalState(input.config);
  const flags =
    typeof input.profile.flags === 'object' && input.profile.flags !== null
      ? (input.profile.flags as { disclaimerAcknowledged?: unknown })
      : null;
  return {
    platform: input.platform,
    ageBand: asAgeBand(input.profile.age_band),
    drivingStage: asDrivingStage(input.profile.driving_stage),
    termsCurrent: hasCurrentTerms(input.consents, flags, legal),
    termsPublished: legal.published,
    minorConsentMode: input.config.minor_consent_mode,
    features: {
      autoDetect: input.config.flags.auto_detect,
      guardianInvites: input.config.flags.guardian_invites,
    },
  };
}

/**
 * The stepper's context, or null while something local is still being read: the profile (a first
 * launch with no cache), the app config cache, or — published only — the cached consents.
 */
export function useFlowContext(): FlowContext | null {
  const { profile, session } = useSession();
  const { config, ready } = useAppConfig();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  // Identity for server calls comes from the verified session only (T12 security M-2).
  const userId = session?.user.id ?? null;
  const published = legalState(config).published;
  const wantConsents = published && userId !== null;

  const cached = useQuery({
    queryKey: consentsCacheQueryKey(userId ?? ''),
    queryFn: () => readCachedConsents(settings, userId ?? ''),
    enabled: wantConsents,
  });
  const client = useQueryClient();
  const network = useQuery({
    queryKey: consentsQueryKey(userId ?? ''),
    queryFn: async () => {
      const rows = await fetchOwnConsents(userId ?? '');
      await writeCachedConsents(settings, userId ?? '', rows).catch(() => {});
      client.setQueryData(consentsCacheQueryKey(userId ?? ''), rows);
      return rows;
    },
    enabled: wantConsents,
  });

  // A band other than u13 for this account ends any earlier block: its removal stamp goes, so a
  // later re-block runs the full removal again (T12 r1 n1). Unknown says nothing either way.
  const band = profile ? asAgeBand(profile.age_band) : null;
  const released = userId !== null && band !== null && band !== 'u13' && band !== 'unknown';
  useEffect(() => {
    if (released) void clearBlockPurged(db);
  }, [released, db]);

  const consents = network.data ?? cached.data ?? null;
  const waiting = wantConsents && !cached.isFetched && network.data === undefined;
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';

  return useMemo(() => {
    if (profile === null || !ready || waiting) return null;
    return buildFlowContext({ platform, profile, config, consents: consents ?? [] });
  }, [profile, ready, waiting, platform, config, consents]);
}

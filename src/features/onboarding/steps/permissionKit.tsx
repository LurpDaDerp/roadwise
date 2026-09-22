/**
 * What the A6–A9 and A12 steps share: reading the phone, recording a permission consent on a
 * grant, and one status line with a drawn glyph.
 *
 * Every OS request these steps make is the driver's own tap on the step's primary button, so it
 * goes to the adapter directly, unthrottled, and stamps the 14-day history so the app's own later
 * offers wait (Ruling T8 r1). None of them asks for background location: that request lives only
 * in `BackgroundDisclosure` (T9 security review).
 */
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, useWindowDimensions, View } from 'react-native';

import type { PermissionSnapshot, PermissionsAdapter } from '@/core/permissions';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import type { AppStateLike } from '@/data/foreground';
import { useDb } from '@/data/queries';
import { recordConsent } from '@/data/supabase/profile';
import { useSession } from '@/data/supabase/session';
import { defaultPermissionsAdapter } from '@/features/permissions/usePermissionHealth';
import { Text, useTheme } from '@/ui';

import {
  PERMISSION_CONSENT_VERSION,
  addPendingPermissionConsent,
  type PermissionConsentType,
} from '../state';

/** What a test (or Task 19's screen) can hand a step in place of the phone. */
export interface PermissionStepDeps {
  adapter?: PermissionsAdapter;
  appState?: AppStateLike;
  now?: () => number;
}

export function useStepDeps(deps: PermissionStepDeps = {}) {
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  return {
    settings,
    adapter: deps.adapter ?? defaultPermissionsAdapter(),
    appState: deps.appState ?? AppState,
    now: deps.now ?? Date.now,
  };
}

export type PhoneRead =
  | { status: 'loading'; reload: () => Promise<PermissionSnapshot | null> }
  | { status: 'error'; reload: () => Promise<PermissionSnapshot | null> }
  | { status: 'ready'; snapshot: PermissionSnapshot; reload: () => Promise<PermissionSnapshot | null> };

/**
 * The phone's permissions, read on mount, on every return to the front (`AppState → active`, so a
 * trip to Settings shows on the way back) and on `reload()`. Never a timer (design §3.5). A read
 * that fails is `error` — never a made-up state (Ruling T8 (6)).
 */
export function usePhone(adapter: PermissionsAdapter, appState: AppStateLike): PhoneRead {
  const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);
  const ticket = useRef(0);

  /** One read of the phone; null when it can't be read. Never a prompt. */
  const read = useCallback(async (): Promise<PermissionSnapshot | null> => {
    try {
      return await adapter.snapshot();
    } catch {
      return null;
    }
  }, [adapter]);

  /** Shows a read unless a newer one started meanwhile or the step has gone. */
  const show = useCallback((mine: number, next: PermissionSnapshot | null) => {
    if (!live.current || mine !== ticket.current) return;
    if (next !== null) setSnapshot(next);
    setFailed(next === null);
  }, []);

  const reload = useCallback(async (): Promise<PermissionSnapshot | null> => {
    const mine = ++ticket.current;
    const next = await read();
    show(mine, next);
    return next;
  }, [read, show]);

  useEffect(() => {
    live.current = true;
    const run = () => {
      const mine = ++ticket.current;
      void read().then((next) => show(mine, next));
    };
    run();
    const sub = appState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => {
      live.current = false;
      sub.remove();
    };
  }, [read, show, appState]);

  if (failed) return { status: 'error', reload };
  if (snapshot === null) return { status: 'loading', reload };
  return { status: 'ready', snapshot, reload };
}

/**
 * Records `type` at `PERMISSION_CONSENT_VERSION` for the signed-in account, once per mount. Only
 * ever called on a grant. Identity comes from the verified session (T12 security M-2); with no
 * session nothing is recorded. A write that fails (offline) is kept, bound to the account, and
 * `finishOnboarding` sends it.
 */
export function useGrantConsent(settings: SettingsRepo) {
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const done = useRef(new Set<PermissionConsentType>());
  return useCallback(
    async (type: PermissionConsentType): Promise<void> => {
      if (userId === null || done.current.has(type)) return;
      done.current.add(type);
      try {
        await recordConsent(userId, { type, version: PERMISSION_CONSENT_VERSION });
      } catch {
        await addPendingPermissionConsent(settings, userId, type).catch(() => {});
      }
    },
    [userId, settings]
  );
}

export type LineTone = 'ok' | 'attention' | 'off' | 'info';

const GLYPH: Record<LineTone, keyof typeof Ionicons.glyphMap> = {
  ok: 'checkmark-circle',
  attention: 'alert-circle',
  off: 'close-circle',
  info: 'information-circle',
};

/** One line of state: a drawn glyph and words, so meaning never rests on colour alone. */
export function StatusLine({ tone, children, testID }: { tone: LineTone; children: string; testID?: string }) {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const ink = {
    ok: th.colors.success,
    attention: th.colors.warning,
    off: th.colors.danger,
    info: th.colors.textMuted,
  }[tone];
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'flex-start', gap: th.space.sm }}
      accessibilityLiveRegion="polite"
    >
      <Ionicons
        name={GLYPH[tone]}
        size={20 * Math.min(fontScale, 2)}
        color={ink}
        style={{ marginTop: 1 }}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
      <Text variant="callout" style={{ flex: 1 }} testID={testID}>
        {children}
      </Text>
    </View>
  );
}

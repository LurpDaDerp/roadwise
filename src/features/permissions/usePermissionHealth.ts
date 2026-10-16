import type { QueryClient } from '@tanstack/react-query';

import {
  createPermissionsAdapter,
  type PermissionSnapshot,
  type PermissionsAdapter,
  type SettingsStore,
} from '@/core/permissions';
import type { SettingsRepo } from '@/data/db/settings';

let sharedAdapter: PermissionsAdapter | null = null;

/** The device adapter, made once. Importing it loads nothing native until a method is called. */
export function defaultPermissionsAdapter(): PermissionsAdapter {
  sharedAdapter ??= createPermissionsAdapter();
  return sharedAdapter;
}

// ─── The "back from Open Settings" acknowledgement ──────────────────────────────────────────────

/**
 * Set when a permission screen sends the driver to the phone's Settings; the next permission
 * report (`reportPermissions`) takes it and sends `ack: true`, so a permission the driver
 * deliberately turned off there is not treated as a lapse.
 */
export const SETTINGS_RETURN_ACK_KEY = 'permissions.settingsReturnAck';

/** How long a trip to Settings counts as "launched from here". */
export const SETTINGS_RETURN_ACK_MS = 30 * 60 * 1000;

export async function markSettingsReturn(settings: Pick<SettingsStore, 'set'>, now: number): Promise<void> {
  await settings.set(SETTINGS_RETURN_ACK_KEY, now);
}

/**
 * Whether the report being made now follows a Settings trip launched from the app: true once,
 * within `SETTINGS_RETURN_ACK_MS` of it (a clock that moved back does not count). Always clears
 * the mark.
 */
export async function takeSettingsReturnAck(
  settings: Pick<SettingsRepo, 'get' | 'remove'>,
  now: number
): Promise<boolean> {
  const at = await settings.get<unknown>(SETTINGS_RETURN_ACK_KEY);
  if (at === null) return false;
  await settings.remove(SETTINGS_RETURN_ACK_KEY);
  return typeof at === 'number' && Number.isFinite(at) && at <= now && now - at <= SETTINGS_RETURN_ACK_MS;
}

// ─── One shared read of the phone ───────────────────────────────────────────────────────────────

export interface PermissionHealthRead {
  snapshot: PermissionSnapshot;
}

/** Every reader of the phone's permissions (the board, `DeviceHost`) shares this query, keyed by account. */
export const permissionHealthKey = (uid: string | null) => ['permissions', 'health', uid ?? ''] as const;

/** One read of the phone; null when it can't be read. Never a prompt. */
export async function readPermissionHealth(
  adapter: Pick<PermissionsAdapter, 'snapshot'>,
  _settings?: unknown
): Promise<PermissionHealthRead | null> {
  try {
    return { snapshot: await adapter.snapshot() };
  } catch {
    return null;
  }
}

/** A shared read no older than this is reused by another reader (the foreground's burst). */
export const SHARED_READ_MS = 2_000;

/**
 * The shared snapshot for a reader outside React's query hooks (`DeviceHost`): through the same
 * query as the permission screen, so a foreground reads the phone once. With no query client it
 * reads directly. Null when it can't be read.
 */
export async function sharedPermissionSnapshot(
  queryClient: QueryClient | null,
  uid: string | null,
  adapter: Pick<PermissionsAdapter, 'snapshot'>,
  settings: Pick<SettingsRepo, 'get' | 'set'>
): Promise<PermissionSnapshot | null> {
  const read = queryClient
    ? await queryClient.fetchQuery({
        queryKey: permissionHealthKey(uid),
        queryFn: () => readPermissionHealth(adapter, settings),
        staleTime: SHARED_READ_MS,
        gcTime: 0,
        retry: false,
      })
    : await readPermissionHealth(adapter, settings);
  return read?.snapshot ?? null;
}

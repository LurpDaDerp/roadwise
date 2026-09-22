// The one prompt policy (product §8.3: "never re-prompt more than once per 14 days"). Every OS
// permission request in the app goes through `createPermissionsAdapter` AND `canPrompt` first,
// then `recordPrompt` (rev1: I3). Pure apart from the settings read/write.
import { PROMPTS_KEY } from './keys';
import type { PromptHistory, PromptPermission, SettingsStore } from './types';

export const PROMPT_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;

const PROMPT_PERMISSIONS: readonly PromptPermission[] = [
  'location',
  'locationAlways',
  'motion',
  'notifications',
];

/**
 * Whether `permission` may be prompted at `now` (epoch ms): never prompted, or at least 14 days
 * since the last prompt. A corrupt record, or one in the future (the clock moved back), is
 * treated as no record — it cannot be trusted to measure 14 days.
 */
export function canPrompt(permission: PromptPermission, history: PromptHistory, now: number): boolean {
  const last = history[permission];
  if (typeof last !== 'number' || !Number.isFinite(last) || last > now) return true;
  return now - last >= PROMPT_INTERVAL_MS;
}

/** The stored history, keeping only well-formed entries. */
export async function readPromptHistory(settings: Pick<SettingsStore, 'get'>): Promise<PromptHistory> {
  const raw = await settings.get<unknown>(PROMPTS_KEY);
  const out: PromptHistory = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const p of PROMPT_PERMISSIONS) {
    const v = (raw as Record<string, unknown>)[p];
    if (typeof v === 'number' && Number.isFinite(v)) out[p] = v;
  }
  return out;
}

/** Record that the OS prompt for `permission` was shown at `now`; returns the new history. */
export async function recordPrompt(
  settings: SettingsStore,
  permission: PromptPermission,
  now: number
): Promise<PromptHistory> {
  const next = { ...(await readPromptHistory(settings)), [permission]: now };
  await settings.set(PROMPTS_KEY, next);
  return next;
}

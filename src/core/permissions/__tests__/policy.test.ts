import { PROMPTS_KEY } from '../keys';
import { canPrompt, PROMPT_INTERVAL_MS, readPromptHistory, recordPrompt } from '../policy';
import type { SettingsStore } from '../types';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function memorySettings(initial: Record<string, unknown> = {}): SettingsStore & {
  data: Record<string, unknown>;
} {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    async get<T>(key: string) {
      return (key in data ? (data[key] as T) : null) ?? null;
    },
    async set(key: string, value: unknown) {
      data[key] = JSON.parse(JSON.stringify(value));
    },
  };
}

describe('canPrompt', () => {
  it('is 14 days', () => {
    expect(PROMPT_INTERVAL_MS).toBe(14 * DAY);
  });

  it('allows a permission never prompted', () => {
    expect(canPrompt('location', {}, T0)).toBe(true);
    expect(canPrompt('motion', { location: T0 }, T0)).toBe(true);
  });

  it('refuses one millisecond before 14 days, allows at exactly 14 days', () => {
    const h = { notifications: T0 };
    expect(canPrompt('notifications', h, T0 + 14 * DAY - 1)).toBe(false);
    expect(canPrompt('notifications', h, T0 + 14 * DAY)).toBe(true);
    expect(canPrompt('notifications', h, T0)).toBe(false);
  });

  it('treats a corrupt or future record (clock moved back) as no record', () => {
    expect(canPrompt('location', { location: Number.NaN }, T0)).toBe(true);
    expect(canPrompt('location', { location: T0 + DAY }, T0)).toBe(true);
  });
});

describe('recordPrompt / readPromptHistory', () => {
  it('stores the prompt time per permission under PROMPTS_KEY, keeping the others', async () => {
    const s = memorySettings({ [PROMPTS_KEY]: { motion: T0 - DAY } });
    const h = await recordPrompt(s, 'locationAlways', T0);
    expect(h).toEqual({ motion: T0 - DAY, locationAlways: T0 });
    expect(s.data[PROMPTS_KEY]).toEqual({ motion: T0 - DAY, locationAlways: T0 });
    expect(await readPromptHistory(s)).toEqual(h);
    expect(canPrompt('locationAlways', await readPromptHistory(s), T0 + DAY)).toBe(false);
  });

  it('reads an absent or malformed history as empty', async () => {
    expect(await readPromptHistory(memorySettings())).toEqual({});
    expect(await readPromptHistory(memorySettings({ [PROMPTS_KEY]: 'junk' }))).toEqual({});
    expect(
      await readPromptHistory(memorySettings({ [PROMPTS_KEY]: { location: 'x', motion: T0, other: 1 } }))
    ).toEqual({ motion: T0 });
  });
});

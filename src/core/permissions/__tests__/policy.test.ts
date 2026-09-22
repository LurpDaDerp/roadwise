import { PROMPTS_KEY } from '../keys';
import { canPrompt, offerPrompt, PROMPT_INTERVAL_MS, readPromptHistory, recordPrompt } from '../policy';
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

describe('offerPrompt (app-initiated prompts)', () => {
  it('asks and records when the window is open', async () => {
    const s = memorySettings();
    const request = jest.fn(async () => 'granted' as const);
    expect(await offerPrompt(s, 'locationAlways', T0, request)).toBe('granted');
    expect(request).toHaveBeenCalledTimes(1);
    expect(s.data[PROMPTS_KEY]).toEqual({ locationAlways: T0 });
  });

  it('skips without calling the OS inside 14 days, and asks again at 14 days', async () => {
    const s = memorySettings({ [PROMPTS_KEY]: { notifications: T0 } });
    const request = jest.fn(async () => 'denied' as const);
    expect(await offerPrompt(s, 'notifications', T0 + 14 * DAY - 1, request)).toBe('skipped');
    expect(request).not.toHaveBeenCalled();
    expect(s.data[PROMPTS_KEY]).toEqual({ notifications: T0 });
    expect(await offerPrompt(s, 'notifications', T0 + 14 * DAY, request)).toBe('denied');
    expect(s.data[PROMPTS_KEY]).toEqual({ notifications: T0 + 14 * DAY });
  });

  it('a request that throws is not recorded and the error propagates', async () => {
    const s = memorySettings();
    await expect(offerPrompt(s, 'motion', T0, () => Promise.reject(new Error('bridge')))).rejects.toThrow(
      'bridge'
    );
    expect(s.data[PROMPTS_KEY]).toBeUndefined();
  });
});

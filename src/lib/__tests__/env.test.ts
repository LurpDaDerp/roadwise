/* eslint-disable @typescript-eslint/no-require-imports -- env.ts validates at import time, so the
   only way to observe both outcomes is to re-require it after jest.resetModules(); a dynamic
   import() is not transpiled to require here and needs --experimental-vm-modules. */
describe('env', () => {
  const OLD = process.env;
  beforeEach(() => { jest.resetModules(); process.env = { ...OLD }; });
  afterAll(() => { process.env = OLD; });

  test('throws a readable error when url missing', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'k';
    // The message has to name the variable: "expected string, received undefined" tells nobody
    // which of the six keys to go and set.
    expect(() => require('@/lib/env')).toThrow(/EXPO_PUBLIC_SUPABASE_URL/);
  });

  test('parses when present', () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'k';
    expect(require('@/lib/env').env.supabaseUrl).toBe('https://x.supabase.co');
  });
});

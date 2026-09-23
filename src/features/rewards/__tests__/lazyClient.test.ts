/**
 * No `@/data/supabase/client` mock here on purpose: the rewards reads, RPCs, cache, view models and
 * copy load the app client (which needs the env) only when a call is made. The hooks import the
 * session module, which loads the client itself, so screen tests still mock it as the inbox's do.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- each module is loaded in isolation */
test('importing the non-hook rewards modules does not load the app client', () => {
  jest.isolateModules(() => {
    expect(() => {
      require('../api');
      require('../cache');
      require('../keys');
      require('../viewModel');
      require('../copy/common');
    }).not.toThrow();
  });
});

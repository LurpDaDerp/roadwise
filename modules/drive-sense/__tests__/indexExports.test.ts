/** @jest-environment node */
// The detector's decision table (`src/detect/vectors.ts`) is test and diagnostics data. The module's
// index must not load it: the index runs at every JS start (the boot, an iOS background relaunch,
// Android's headless task), so a value export from it would bundle the table in a store build and
// build it at every launch. The diagnostics self-test reads the file itself, behind its build-time
// gate (`src/features/dev/SelfTestPanel.tsx`).

test('loading the module never loads the decision table', () => {
  let loaded = false;
  jest.isolateModules(() => {
    jest.doMock('../src/detect/vectors', () => {
      loaded = true;
      return {};
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded inside the isolated registry
    const index = require('../index') as Record<string, unknown>;
    expect(index).not.toHaveProperty('DETECT_VECTORS');
  });
  expect(loaded).toBe(false);
});

// The cross-repo DashPal link test (plan §9): `npm run e2e:dashpal`. It drives the firmware's host
// simulator (`ble_sim`, built in WSL from the firmware checkout) against the app's real transport,
// link and alert controller, so it is kept out of the default `npm test` run (whose testMatch never
// matches `*.e2e.ts`). Without WSL or the firmware checkout the suites are skipped with the reason
// printed; `DASHPAL_E2E_REQUIRED=1` makes that a failure. See src/dashcam/__e2e__/world.ts.
const base = require('./jest.config.js');

module.exports = {
  ...base,
  testMatch: ['<rootDir>/src/dashcam/__e2e__/*.e2e.ts'],
  testEnvironment: 'node',
  // Each scenario runs a simulator process; a cold WSL start can take a few seconds.
  testTimeout: 30_000,
};

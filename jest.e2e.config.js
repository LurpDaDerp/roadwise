// The cross-repo DashPal link test (plan §9): `npm run e2e:dashpal`. It drives the firmware's host
// simulator (WSL) against the real link and alert controller, so it is kept out of the default
// `npm test` run (whose testMatch never matches `*.e2e.ts`).
const base = require('./jest.config.js');

module.exports = {
  ...base,
  testMatch: ['<rootDir>/src/dashcam/__e2e__/*.e2e.ts'],
  testEnvironment: 'node',
  // The suite arrives with the link test; until then the script has nothing to run.
  passWithNoTests: true,
};

// The e2e suites' gate: they run against the firmware simulator in WSL, built on demand. Without it
// (no WSL, no firmware checkout, no gcc) they are skipped with the reason printed, unless
// `DASHPAL_E2E_REQUIRED=1`, which turns the skip into a failure.
import { prepareSimulator } from './sim';

declare const process: { env: Record<string, string | undefined> };

const sim = prepareSimulator();
const required = process.env.DASHPAL_E2E_REQUIRED === '1';

if (!sim.ok && !required) {
  console.warn(`DashPal cross-repo e2e SKIPPED: ${sim.why}`);
}

/** `describe` when the simulator runs, `describe.skip` otherwise (or a failing suite when required). */
export const describeSim: jest.Describe = sim.ok
  ? describe
  : required
    ? ((name: string, fn: () => void) =>
        describe(name, () => {
          test('the firmware simulator is available', () => {
            throw new Error(`DASHPAL_E2E_REQUIRED=1 but ${sim.why}`);
          });
          void fn;
        })) as unknown as jest.Describe
    : describe.skip;

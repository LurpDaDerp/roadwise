/** @jest-environment node */
// Review M3: no golden vector may put a computed value within MARGIN_MIN of a threshold it is
// compared with, or a port's different atan2/sqrt rounding could take the other branch.
import { MARGIN_MIN } from '../src/extract/probe';
import { extractSecond, initialExtractState } from '../src/extract/extract';
import { measureMargins, VECTOR_BUILDERS, VECTOR_NAMES, withMarginCheck, T0 } from '../scripts/scenarios';

test.each(VECTOR_NAMES)('%s keeps every threshold comparison at least MARGIN_MIN away', (name) => {
  const { margins } = measureMargins(() => VECTOR_BUILDERS[name]());
  expect(margins.size).toBeGreaterThan(0);
  for (const m of margins.values()) expect(m).toBeGreaterThanOrEqual(MARGIN_MIN);
});

test('the check refuses a scenario sitting on a threshold', () => {
  const onBoundary = () =>
    extractSecond(
      [],
      { t: T0 + 800, lat: 0, lng: 0, hAcc: 50, speed: 10, speedAcc: 1, course: 0, alt: 0 }, // hAcc exactly GNSS_MAX_HACC_M
      { locked: true, screenOn: false, appForeground: true },
      T0 + 1000,
      initialExtractState()
    );
  expect(() => withMarginCheck('boundary', onBoundary)).toThrow(/GNSS_MAX_HACC_M/);
});

test('the probe is uninstalled afterwards, even when the scenario throws', () => {
  expect(() =>
    measureMargins(() => {
      throw new Error('boom');
    })
  ).toThrow('boom');
  const { margins } = measureMargins(() => 1);
  expect(margins.size).toBe(0);
});

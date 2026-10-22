import { detectWireVectors, referenceDetectOutput, runSelfTest, type DriveSenseApi } from '@drive-sense';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ThemeProvider } from '@/ui';

import { loadDetectVectors, loadVectors, SelfTestPanel, VECTOR_NAMES } from '../SelfTestPanel';

type SelfTestSource = Pick<DriveSenseApi, 'selfTest'>;
type Platform = 'ios' | 'android';
type Output = { version: 1; platform: Platform; results: Record<string, unknown>[] };

/** What a correct native port answers: the TS reference run over the same vectors. */
function referenceOutput(platform: Platform): Output {
  const out = runSelfTest(loadVectors(), 'reference') as unknown as {
    results: Record<string, unknown>[];
  };
  const results = out.results.map((r) =>
    platform === 'ios' && r.kind !== 'extract'
      ? { name: r.name, kind: r.kind, skipped: 'iOS has no gravity filter or raw accelerometer path' }
      : r
  );
  return { version: 1, platform, results };
}

/** What a correct native detector answers: iOS the reference; Android (no detector) every row skipped. */
function detectOutput(platform: Platform): Output {
  const out = referenceDetectOutput(detectWireVectors(loadDetectVectors()));
  const results = platform === 'ios' ? out.results : out.results.map((r) => ({ name: r.name, kind: 'detect', skipped: 'no drive detector on Android' }));
  return { version: 1, platform, results };
}

/** Answers the golden call with `golden` and the detector call with `detect`. */
function sourceAnswering(golden: unknown, detect: unknown): SelfTestSource & { selfTest: jest.Mock } {
  return {
    selfTest: jest.fn(async (json: string) => {
      const sent = JSON.parse(json) as { kind: string }[];
      return JSON.stringify(sent[0]?.kind === 'detect' ? detect : golden);
    }),
  };
}

async function renderPanel(source: SelfTestSource) {
  await render(
    <ThemeProvider>
      <SelfTestPanel source={source} />
    </ThemeProvider>
  );
}

const ROWS = loadDetectVectors();
const N = VECTOR_NAMES.length + ROWS.length;

test('loads every golden vector from the drive-sense assets, validated, and the detector table', () => {
  const vectors = loadVectors();
  expect(vectors.map((v) => v.name)).toEqual([...VECTOR_NAMES]);
  expect(VECTOR_NAMES).toHaveLength(10);
  expect(ROWS.length).toBeGreaterThan(10);
});

test('sends native the golden vectors, then the detector rows without their answers, and reports a full match', async () => {
  const source = sourceAnswering(referenceOutput('android'), detectOutput('ios'));
  await renderPanel(source);
  await fireEvent.press(screen.getByRole('button', { name: 'Run self-test' }));
  expect(await screen.findByText(`All ${N} vectors match the reference`)).toBeTruthy();
  const golden = JSON.parse(source.selfTest.mock.calls[0]![0] as string) as { name: string }[];
  expect(golden.map((v) => v.name)).toEqual([...VECTOR_NAMES]);
  const detect = JSON.parse(source.selfTest.mock.calls[1]![0] as string) as { name: string; kind: string; inputs: Record<string, unknown> }[];
  expect(detect.map((v) => v.name)).toEqual(ROWS.map((r) => r.name));
  expect(detect.every((v) => v.kind === 'detect' && !('expected' in v.inputs))).toBe(true);
});

test('Android skipping every detector row (it has none) still passes, and says so', async () => {
  await renderPanel(sourceAnswering(referenceOutput('android'), detectOutput('android')));
  await fireEvent.press(screen.getByRole('button', { name: 'Run self-test' }));
  expect(await screen.findByText(`All ${N} vectors match the reference`)).toBeTruthy();
  expect(screen.getAllByText(/^Skipped: /)).toHaveLength(ROWS.length);
});

test('a perturbed native field is named by its path, with both values', async () => {
  const output = referenceOutput('android') as unknown as { results: { name: string; rows?: Record<string, number>[] }[] };
  const brake = output.results.find((r) => r.name === 'hard-brake')!;
  const expected = brake.rows![8]!.aLonMin!;
  brake.rows![8]!.aLonMin = expected + 0.25;
  await renderPanel(sourceAnswering(output, detectOutput('ios')));
  await fireEvent.press(screen.getByRole('button', { name: 'Run self-test' }));
  expect(await screen.findByText(`1 of ${N} vectors differ from the reference`)).toBeTruthy();
  expect(screen.getByText('hard-brake')).toBeTruthy();
  expect(screen.getByText('rows[8].aLonMin')).toBeTruthy();
  expect(screen.getByText(`expected ${expected.toFixed(4)}, native ${(expected + 0.25).toFixed(4)}`)).toBeTruthy();
});

test('a native detector rule that drifts from the table is named; an iPhone that skips a row fails', async () => {
  const detect = detectOutput('ios');
  // A confirmation time no row of the table answers (null or a real time alike), so the drift
  // holds whichever row comes first.
  detect.results[0] = { ...detect.results[0], actual: { ...(detect.results[0]!.actual as Record<string, unknown>), confirmedAt: 12_345 } };
  const skippedName = String(detect.results[1]!.name);
  detect.results[1] = { name: skippedName, kind: 'detect', skipped: 'no' };
  await renderPanel(sourceAnswering(referenceOutput('android'), detect));
  await fireEvent.press(screen.getByRole('button', { name: 'Run self-test' }));
  expect(await screen.findByText(`2 of ${N} vectors differ from the reference`)).toBeTruthy();
  expect(screen.getByText(String(detect.results[0]!.name))).toBeTruthy();
  expect(screen.getByText('confirmedAt')).toBeTruthy();
  expect(screen.getByText('skipped (no), but ios has the drive detector')).toBeTruthy();
});

test('a native rejection is shown as the error it is, not as a pass', async () => {
  const source: SelfTestSource = {
    selfTest: jest.fn(async () => {
      throw new Error('DriveSense native module is not available (Jest, Expo Go or web)');
    }),
  };
  await renderPanel(source);
  await fireEvent.press(screen.getByRole('button', { name: 'Run self-test' }));
  await waitFor(() => expect(screen.getByText(/native module is not available/)).toBeTruthy());
  expect(screen.queryByText(/match the reference/)).toBeNull();
});

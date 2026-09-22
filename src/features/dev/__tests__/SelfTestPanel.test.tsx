import { runSelfTest, type DriveSenseApi } from '@drive-sense';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ThemeProvider } from '@/ui';

import { loadVectors, SelfTestPanel, VECTOR_NAMES } from '../SelfTestPanel';

type SelfTestSource = Pick<DriveSenseApi, 'selfTest'>;

/** What a correct native port answers: the TS reference run over the same vectors. */
function referenceOutput(platform: 'ios' | 'android'): Record<string, unknown> {
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

function sourceAnswering(output: unknown): SelfTestSource & { selfTest: jest.Mock } {
  return { selfTest: jest.fn(async () => JSON.stringify(output)) };
}

async function renderPanel(source: SelfTestSource) {
  await render(
    <ThemeProvider>
      <SelfTestPanel source={source} />
    </ThemeProvider>
  );
}

test('loads every golden vector from the drive-sense assets, validated', () => {
  const vectors = loadVectors();
  expect(vectors.map((v) => v.name)).toEqual([...VECTOR_NAMES]);
  expect(VECTOR_NAMES).toHaveLength(10);
});

test('sends native the vectors as one JSON array and reports a full match', async () => {
  const source = sourceAnswering(referenceOutput('android'));
  await renderPanel(source);
  await fireEvent.press(screen.getByRole('button', { name: 'Run self-test' }));
  expect(await screen.findByText('All 10 vectors match the reference')).toBeTruthy();
  const sent = JSON.parse(source.selfTest.mock.calls[0]![0] as string) as { name: string }[];
  expect(sent.map((v) => v.name)).toEqual([...VECTOR_NAMES]);
});

test('iOS skipping the gravity-filter and android-raw vectors still passes, and says so', async () => {
  await renderPanel(sourceAnswering(referenceOutput('ios')));
  await fireEvent.press(screen.getByRole('button', { name: 'Run self-test' }));
  expect(await screen.findByText('All 10 vectors match the reference')).toBeTruthy();
  expect(screen.getAllByText(/Skipped on iOS/)).toHaveLength(2);
});

test('a perturbed native field is named by its path, with both values', async () => {
  const output = referenceOutput('android') as { results: { name: string; rows?: Record<string, number>[] }[] };
  const brake = output.results.find((r) => r.name === 'hard-brake')!;
  const expected = brake.rows![8]!.aLonMin!;
  brake.rows![8]!.aLonMin = expected + 0.25;
  await renderPanel(sourceAnswering(output));
  await fireEvent.press(screen.getByRole('button', { name: 'Run self-test' }));
  expect(await screen.findByText('1 of 10 vectors differ from the reference')).toBeTruthy();
  expect(screen.getByText('hard-brake')).toBeTruthy();
  expect(screen.getByText('rows[8].aLonMin')).toBeTruthy();
  expect(screen.getByText(`expected ${expected.toFixed(4)}, native ${(expected + 0.25).toFixed(4)}`)).toBeTruthy();
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

import {
  referenceReminderOutput,
  reminderRowRunsOn,
  reminderWireVectors,
  runSelfTest,
  type DriveSenseApi,
} from '@drive-sense';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ThemeProvider } from '@/ui';

import { loadReminderVectors, loadVectors, SelfTestPanel, VECTOR_NAMES } from '../SelfTestPanel';

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

/** What a correct native reminder mirror answers: the reference, the other platform's rows skipped. */
function reminderOutput(platform: Platform): Output {
  const rows = loadReminderVectors();
  const out = referenceReminderOutput(reminderWireVectors(rows));
  const results = out.results.map((r, i) =>
    reminderRowRunsOn(rows[i]!, platform) ? r : { name: r.name, kind: 'reminder', skipped: `not a ${platform} rule` }
  );
  return { version: 1, platform, results };
}

/** Answers the golden call with `golden` and the reminder call with `reminder`. */
function sourceAnswering(golden: unknown, reminder: unknown): SelfTestSource & { selfTest: jest.Mock } {
  return {
    selfTest: jest.fn(async (json: string) => {
      const sent = JSON.parse(json) as { kind: string }[];
      return JSON.stringify(sent[0]?.kind === 'reminder' ? reminder : golden);
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

const ROWS = loadReminderVectors();
const N = VECTOR_NAMES.length + ROWS.length;

test('loads every golden vector from the drive-sense assets, validated, and the reminder table', () => {
  const vectors = loadVectors();
  expect(vectors.map((v) => v.name)).toEqual([...VECTOR_NAMES]);
  expect(VECTOR_NAMES).toHaveLength(10);
  expect(ROWS.length).toBeGreaterThanOrEqual(60);
});

test('sends native the golden vectors, then the reminder rows without their answers, and reports a full match', async () => {
  const source = sourceAnswering(referenceOutput('android'), reminderOutput('android'));
  await renderPanel(source);
  await fireEvent.press(screen.getByRole('button', { name: 'Run self-test' }));
  expect(await screen.findByText(`All ${N} vectors match the reference`)).toBeTruthy();
  const golden = JSON.parse(source.selfTest.mock.calls[0]![0] as string) as { name: string }[];
  expect(golden.map((v) => v.name)).toEqual([...VECTOR_NAMES]);
  const reminder = JSON.parse(source.selfTest.mock.calls[1]![0] as string) as { name: string; kind: string; inputs: Record<string, unknown> }[];
  expect(reminder.map((v) => v.name)).toEqual(ROWS.map((r) => r.name));
  expect(reminder.every((v) => v.kind === 'reminder' && !('expected' in v.inputs))).toBe(true);
});

test("iOS skipping the gravity-filter and android-raw vectors and Android's reminder rows still passes, and says so", async () => {
  await renderPanel(sourceAnswering(referenceOutput('ios'), reminderOutput('ios')));
  await fireEvent.press(screen.getByRole('button', { name: 'Run self-test' }));
  expect(await screen.findByText(`All ${N} vectors match the reference`)).toBeTruthy();
  const androidOnly = ROWS.filter((r) => !reminderRowRunsOn(r, 'ios')).length;
  expect(androidOnly).toBeGreaterThan(0);
  expect(screen.getAllByText(/^Skipped: /)).toHaveLength(2 + androidOnly);
});

test('a perturbed native field is named by its path, with both values', async () => {
  const output = referenceOutput('android') as unknown as { results: { name: string; rows?: Record<string, number>[] }[] };
  const brake = output.results.find((r) => r.name === 'hard-brake')!;
  const expected = brake.rows![8]!.aLonMin!;
  brake.rows![8]!.aLonMin = expected + 0.25;
  await renderPanel(sourceAnswering(output, reminderOutput('android')));
  await fireEvent.press(screen.getByRole('button', { name: 'Run self-test' }));
  expect(await screen.findByText(`1 of ${N} vectors differ from the reference`)).toBeTruthy();
  expect(screen.getByText('hard-brake')).toBeTruthy();
  expect(screen.getByText('rows[8].aLonMin')).toBeTruthy();
  expect(screen.getByText(`expected ${expected.toFixed(4)}, native ${(expected + 0.25).toFixed(4)}`)).toBeTruthy();
});

test('a native reminder rule that drifts from the table is named, and a skipped Android rule fails', async () => {
  const reminder = reminderOutput('android');
  const posts = reminder.results.find((r) => r.name === 'android: [EXIT, STILL] in a driven session posts, the note timing out at the session end')!;
  posts.actual = { ...(posts.actual as Record<string, unknown>), effect: 'none' };
  const stale = reminder.results.findIndex((r) => r.name === 'android: a stop 46 s old on arrival is stale');
  reminder.results[stale] = { name: 'android: a stop 46 s old on arrival is stale', kind: 'reminder', skipped: 'no' };
  await renderPanel(sourceAnswering(referenceOutput('android'), reminder));
  await fireEvent.press(screen.getByRole('button', { name: 'Run self-test' }));
  expect(await screen.findByText(`2 of ${N} vectors differ from the reference`)).toBeTruthy();
  expect(screen.getByText('android: [EXIT, STILL] in a driven session posts, the note timing out at the session end')).toBeTruthy();
  expect(screen.getByText('effect')).toBeTruthy();
  expect(screen.getByText('expected "post", native "none"')).toBeTruthy();
  expect(screen.getByText('skipped (no), but android has this rule')).toBeTruthy();
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

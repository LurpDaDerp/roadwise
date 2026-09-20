import { screen, within } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { scoringChangelog, scoringExplainer } from '@/content/scoring-explainer';
import {
  clearQueryClients,
  flush,
  press,
  routerDouble,
  world,
} from '@/features/insights/__fixtures__/render';
import { HowScoringWorksScreen } from '@/features/insights/HowScoringWorksScreen';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

beforeEach(() => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});

afterEach(clearQueryClients);

async function open() {
  const w = await world();
  await w.renderScreen(<HowScoringWorksScreen />);
  await screen.findByTestId('how-scoring-works');
}

test('every block of the explainer is on the page, each as its own heading', async () => {
  await open();

  for (const block of scoringExplainer) {
    expect(screen.getByTestId(`block-${block.id}`)).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: block.title })).toBeOnTheScreen();
    expect(screen.getByText(block.body)).toBeOnTheScreen();
  }
  // The four trust blocks §7.E E4 names by hand, so a renamed id cannot quietly drop one.
  expect(screen.getByRole('header', { name: 'What we measure' })).toBeOnTheScreen();
  expect(screen.getByRole('header', { name: 'What we do not measure' })).toBeOnTheScreen();
  expect(screen.getByRole('header', { name: 'If something is wrong, say so' })).toBeOnTheScreen();
  expect(screen.getByRole('header', { name: 'What this score is not' })).toBeOnTheScreen();
});

test('the initial-model statement is printed, not implied', async () => {
  await open();

  expect(screen.getByRole('header', { name: 'This is an initial model' })).toBeOnTheScreen();
  expect(
    screen.getByText(/These thresholds and weights are our first version and we are still tuning them\./)
  ).toBeOnTheScreen();
  expect(screen.getByText(/not from insurance data or a claims history/)).toBeOnTheScreen();
});

test('the caps are drawn as boxes, summed out loud, and readable as a table', async () => {
  await open();

  expect(screen.getByText('The caps add up to 100, the whole of one drive.')).toBeOnTheScreen();
  expect(
    screen.getByRole('image', { name: /^Most a category can cost one drive\. Phone use, at most 30 points a drive/ })
  ).toBeOnTheScreen();

  await press(within(screen.getByTestId('caps-chart')).getByRole('button', { name: 'Show as table' }));
  await flush();
  const table = within(screen.getByTestId('caps-chart-table'));
  expect(table.getByLabelText('Phone use, at most 30 points a drive')).toBeOnTheScreen();
  expect(table.getByLabelText('Rapid acceleration, at most 8 points a drive')).toBeOnTheScreen();
});

test('the scoring changelog is on the page, so a model change can never be silent', async () => {
  await open();

  expect(screen.getByTestId('changelog')).toBeOnTheScreen();
  for (const entry of scoringChangelog) {
    expect(
      screen.getByLabelText(`Version ${entry.version}, ${entry.date}, ${entry.summary}`)
    ).toBeOnTheScreen();
  }
  expect(screen.getByLabelText('Version 1, 2026-09-20, Initial model')).toBeOnTheScreen();
});

test('the caps chart is hidden from assistive tech behind its own label, not read twice', async () => {
  await open();

  // The bars themselves are inside the labelled image and reachable only when asked for.
  expect(screen.queryByTestId('caps-bars-track-phone')).toBeNull();
  expect(screen.getByTestId('caps-bars-track-phone', { includeHiddenElements: true })).toBeOnTheScreen();
});

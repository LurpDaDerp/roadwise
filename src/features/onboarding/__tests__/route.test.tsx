/**
 * The route file itself: the `step` param reaches the stepper, and the stand-in context (until
 * Task 12's `useFlowContext`) comes from the signed-in profile.
 */
import { render, screen, waitFor } from '@testing-library/react-native';

import { DataProvider } from '@/data/queries';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { ThemeProvider } from '@/ui/theme';

import OnboardingStepRoute from '../../../../app/(onboarding)/[step]';
import { resetSessionPlan } from '../Stepper';

const mockRouter = { replace: jest.fn() };
let mockParams: Record<string, string | string[] | undefined> = {};
let mockProfile: { age_band: string; driving_stage: string } | null = null;

jest.mock('expo-router', () => {
  const { Text: MockText } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    useRouter: () => mockRouter,
    useLocalSearchParams: () => mockParams,
    Redirect: ({ href }: { href: string }) => <MockText testID="redirect">{href}</MockText>,
  };
});
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ profile: mockProfile }),
}));

async function renderRoute() {
  const db = await createTestDb();
  return render(
    <ThemeProvider>
      <DataProvider db={db}>
        <OnboardingStepRoute />
      </DataProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  mockRouter.replace.mockClear();
  resetSessionPlan();
  mockProfile = { age_band: '18_plus', driving_stage: 'new' };
});

describe('app/(onboarding)/[step]', () => {
  it.each([{ step: 'nope' }, { step: ['terms', 'extra'] }, {}])(
    'sends %p to start',
    async (params) => {
      mockParams = params;
      await renderRoute();
      expect(screen.getByTestId('redirect')).toHaveTextContent('/(onboarding)/start');
    }
  );

  it('resolves start from the profile: an under-13 account goes to the block', async () => {
    mockParams = { step: 'start' };
    mockProfile = { age_band: 'u13', driving_stage: 'unknown' };
    await renderRoute();
    await waitFor(() =>
      expect(mockRouter.replace).toHaveBeenCalledWith('/(onboarding)/not-eligible')
    );
  });

  it('holds the skeleton until the profile has loaded', async () => {
    mockParams = { step: 'location' };
    mockProfile = null;
    await renderRoute();
    expect(screen.getByLabelText('Loading')).toBeOnTheScreen();
    expect(screen.queryByTestId('redirect')).toBeNull();
  });

  it('renders the requested step when it is in the flow', async () => {
    mockParams = { step: 'terms' };
    await renderRoute();
    expect(screen.getByRole('header', { name: 'Terms' })).toBeOnTheScreen();
  });
});

/**
 * The route file itself: the `step` param reaches the stepper, and the context (`useFlowContext`,
 * Task 12) comes from the signed-in profile and the cached app config.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react-native';

import { createQueryClient, DataProvider } from '@/data/queries';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { DISCLAIMER_VERSION } from '@/features/auth/legal';
import { ThemeProvider } from '@/ui/theme';

import OnboardingStepRoute from '../../../../app/(onboarding)/[step]';
import { resetSessionPlan } from '../Stepper';

const mockRouter = { replace: jest.fn() };
let mockParams: Record<string, string | string[] | undefined> = {};
let mockProfile: { id: string; age_band: string; driving_stage: string; flags?: unknown } | null =
  null;

jest.mock('expo-router', () => {
  const { Text: MockText } = jest.requireActual<typeof import('react-native')>('react-native');
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    // Every screen in these suites is focused; `Stepper.router.test.tsx` covers a covered one.
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
    useRouter: () => mockRouter,
    useLocalSearchParams: () => mockParams,
    Redirect: ({ href }: { href: string }) => <MockText testID="redirect">{href}</MockText>,
  };
});
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({
    profile: mockProfile,
    session: mockProfile ? { user: { id: 'user-1' } } : null,
    refreshProfile: async () => {},
  }),
}));
// The steps' server calls are never made here; the client must not need a configured project.
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/config/appConfig', () => {
  const actual = jest.requireActual('@/data/config/appConfig');
  const mockAppConfig = { config: { ...actual.CONFIG_DEFAULTS, fetchedAt: 1 }, ready: true };
  return { ...actual, useAppConfig: () => mockAppConfig };
});

let client: ReturnType<typeof createQueryClient>;
afterEach(() => client?.clear());

async function renderRoute() {
  const db = await createTestDb();
  client = createQueryClient();
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <DataProvider db={db}>
          <OnboardingStepRoute />
        </DataProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  mockRouter.replace.mockClear();
  resetSessionPlan();
  mockProfile = { id: 'user-1', age_band: '18_plus', driving_stage: 'new', flags: {} };
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
    mockProfile = { id: 'user-1', age_band: 'u13', driving_stage: 'unknown', flags: {} };
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

  it('renders the requested step when it is in the flow (Terms owed: nothing acknowledged yet)', async () => {
    mockParams = { step: 'terms' };
    await renderRoute();
    expect(screen.getByRole('header', { name: 'Before you start' })).toBeOnTheScreen();
  });

  it('with the disclaimer acknowledged and nothing published, Terms are current: terms moves on', async () => {
    mockParams = { step: 'terms' };
    mockProfile = {
      id: 'user-1',
      age_band: '18_plus',
      driving_stage: 'new',
      flags: { disclaimerAcknowledged: DISCLAIMER_VERSION },
    };
    await renderRoute();
    expect(screen.getByTestId('redirect')).toHaveTextContent('/(onboarding)/location');
  });
});

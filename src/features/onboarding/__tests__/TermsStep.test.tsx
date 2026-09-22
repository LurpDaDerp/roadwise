import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { CONFIG_DEFAULTS, type AppConfig } from '@/data/config/appConfig';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { createQueryClient } from '@/data/queries/client';
import { DataProvider } from '@/data/queries/context';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { DISCLAIMER_VERSION } from '@/features/auth/legal';
import { DISCLAIMER_ACK_KEY, PENDING_TERMS_KEY } from '@/features/auth/pendingConsent';
import { ThemeProvider } from '@/ui/theme';

import { CONSENTS_CACHE_KEY, consentsQueryKey } from '../context';
import type { FlowContext } from '../flow';
import { TermsStep } from '../steps/TermsStep';

const USER = 'user-1';
const mockConfig: { config: AppConfig; ready: boolean } = {
  config: { ...CONFIG_DEFAULTS, fetchedAt: 1 },
  ready: true,
};
const mockSession = {
  session: { user: { id: USER } },
  profile: { id: USER, flags: { theme: 'dark' } as Record<string, unknown> },
  refreshProfile: jest.fn(async () => {}),
};
const mockUpdateOwnProfile = jest.fn(async (_id: string, _patch: unknown) => ({}));
const mockRecordConsent = jest.fn(async (_id: string, _c: unknown) => ({}));
const mockHeld: { type: string; version: string; revoked_at: null }[] = [];

jest.mock('@/data/config/appConfig', () => ({
  ...jest.requireActual('@/data/config/appConfig'),
  useAppConfig: () => mockConfig,
}));
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/profile', () => ({
  updateOwnProfile: (id: string, patch: unknown) => mockUpdateOwnProfile(id, patch),
  recordConsent: (id: string, c: unknown) => mockRecordConsent(id, c),
}));
// `flushPendingConsents` reads the account's consents before recording what is missing.
jest.mock('@/data/supabase/client', () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => Promise.resolve({ data: mockHeld, error: null }),
  };
  return { supabase: { from: () => chain } };
});

const PUBLISHED: AppConfig = {
  ...CONFIG_DEFAULTS,
  fetchedAt: 1,
  onboarding: { tos_version: 't-2', privacy_version: 'p-3' },
  legal_urls: { terms: 'https://roadwise.example/terms', privacy: 'https://roadwise.example/privacy' },
};
const UNPUBLISHED: AppConfig = {
  ...CONFIG_DEFAULTS,
  fetchedAt: 1,
  onboarding: { tos_version: 't-2', privacy_version: 'p-3' },
  // Terms exist, the Privacy Policy does not: nothing is published (both are needed).
  legal_urls: { terms: 'https://roadwise.example/terms' },
};

const ctx: FlowContext = {
  platform: 'ios',
  ageBand: 'unknown',
  drivingStage: 'unknown',
  termsCurrent: false,
  termsPublished: false,
  minorConsentMode: 'guardian_link_optional',
  features: { autoDetect: true, guardianInvites: false },
};

let db: Db;
let client: ReturnType<typeof createQueryClient>;
const onNext = jest.fn();

async function renderStep() {
  db = await createTestDb();
  client = createQueryClient();
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <DataProvider db={db}>
          <TermsStep ctx={ctx} onNext={onNext} />
        </DataProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

afterEach(() => {
  // The query cache's timers would otherwise keep the process alive after the suite.
  client?.clear();
});

beforeEach(() => {
  onNext.mockClear();
  mockUpdateOwnProfile.mockReset().mockResolvedValue({});
  mockRecordConsent.mockReset().mockResolvedValue({});
  mockSession.refreshProfile.mockReset().mockResolvedValue(undefined);
  mockSession.profile = { id: USER, flags: { theme: 'dark' } };
  mockHeld.length = 0;
  mockConfig.ready = true;
});

describe('TermsStep — documents not published (rev1: I7)', () => {
  beforeEach(() => {
    mockConfig.config = UNPUBLISHED;
  });

  it('asks only about the disclaimer: no Terms, no Privacy, no links', async () => {
    await renderStep();
    const box = screen.getByRole('checkbox');
    expect(box.props.accessibilityLabel).toBe(
      'I understand RoadWise is a coaching aid and may miss or misreport events.'
    );
    expect(box.props.accessibilityLabel).not.toMatch(/terms|privacy/i);
    expect(screen.queryByText(/terms|privacy/i)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(box.props.accessibilityState).toMatchObject({ checked: false });
  });

  it('Continue waits for the tick', async () => {
    await renderStep();
    expect(screen.getByTestId('terms-continue').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await fireEvent.press(screen.getByTestId('terms-continue'));
    expect(mockUpdateOwnProfile).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });

  it('records no consent; acknowledges the disclaimer in flags, then refreshes and moves on', async () => {
    await renderStep();
    await fireEvent.press(screen.getByRole('checkbox'));
    await fireEvent.press(screen.getByTestId('terms-continue'));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));

    expect(mockRecordConsent).not.toHaveBeenCalled();
    expect(mockUpdateOwnProfile).toHaveBeenCalledWith(USER, {
      flags: { theme: 'dark', disclaimerAcknowledged: DISCLAIMER_VERSION },
    });
    expect(mockSession.refreshProfile).toHaveBeenCalled();
    const settings = createSettingsRepo(db);
    expect(await settings.get(DISCLAIMER_ACK_KEY)).toBe(DISCLAIMER_VERSION);
    expect(await settings.get(PENDING_TERMS_KEY)).toBeNull();
  });

  it('a failed write says so in place, and Continue tries again', async () => {
    mockUpdateOwnProfile.mockRejectedValueOnce(new Error('offline'));
    await renderStep();
    await fireEvent.press(screen.getByRole('checkbox'));
    await fireEvent.press(screen.getByTestId('terms-continue'));
    expect(await screen.findByText("Couldn't save that. Try again.")).toBeOnTheScreen();
    expect(onNext).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('terms-continue'));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Couldn't save that. Try again.")).toBeNull();
  });

  it('does not write flags that already hold the current acknowledgement', async () => {
    mockSession.profile = { id: USER, flags: { disclaimerAcknowledged: DISCLAIMER_VERSION } };
    await renderStep();
    await fireEvent.press(screen.getByRole('checkbox'));
    await fireEvent.press(screen.getByTestId('terms-continue'));
    await waitFor(() => expect(onNext).toHaveBeenCalled());
    expect(mockUpdateOwnProfile).not.toHaveBeenCalled();
  });
});

describe('TermsStep — documents published', () => {
  beforeEach(() => {
    mockConfig.config = PUBLISHED;
  });

  it('one box that names the disclaimer and both documents, with the links', async () => {
    await renderStep();
    expect(screen.getByRole('checkbox').props.accessibilityLabel).toBe(
      'I understand RoadWise is a coaching aid and may miss or misreport events. I agree to the Terms and Privacy Policy.'
    );
    expect(screen.getByRole('link', { name: 'Terms' })).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toBeOnTheScreen();
  });

  it('records both consents at the published versions and acknowledges the disclaimer', async () => {
    await renderStep();
    await fireEvent.press(screen.getByRole('checkbox'));
    await fireEvent.press(screen.getByTestId('terms-continue'));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));

    expect(mockRecordConsent.mock.calls).toEqual([
      [USER, { type: 'tos', version: 't-2' }],
      [USER, { type: 'privacy', version: 'p-3' }],
    ]);
    expect(mockUpdateOwnProfile).toHaveBeenCalledWith(USER, {
      flags: { theme: 'dark', disclaimerAcknowledged: DISCLAIMER_VERSION },
    });
    // The flow sees the consents at once, and so does the next offline start.
    expect(client.getQueryData(consentsQueryKey(USER))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tos', version: 't-2' }),
        expect.objectContaining({ type: 'privacy', version: 'p-3' }),
      ])
    );
    const cached = await createSettingsRepo(db).get<{ userId: string }>(CONSENTS_CACHE_KEY);
    expect(cached?.userId).toBe(USER);
  });

  it('a consent the account already holds is not recorded twice', async () => {
    mockHeld.push({ type: 'tos', version: 't-2', revoked_at: null });
    await renderStep();
    await fireEvent.press(screen.getByRole('checkbox'));
    await fireEvent.press(screen.getByTestId('terms-continue'));
    await waitFor(() => expect(onNext).toHaveBeenCalled());
    expect(mockRecordConsent.mock.calls).toEqual([[USER, { type: 'privacy', version: 'p-3' }]]);
  });

  it('a failed consent write moves nowhere and says so', async () => {
    mockRecordConsent.mockRejectedValueOnce(new Error('offline'));
    await renderStep();
    await fireEvent.press(screen.getByRole('checkbox'));
    await fireEvent.press(screen.getByTestId('terms-continue'));
    expect(await screen.findByText("Couldn't save that. Try again.")).toBeOnTheScreen();
    expect(onNext).not.toHaveBeenCalled();
    expect(mockSession.refreshProfile).not.toHaveBeenCalled();
  });
});

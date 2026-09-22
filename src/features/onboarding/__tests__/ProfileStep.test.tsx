import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ThemeProvider } from '@/ui/theme';

import type { FlowContext } from '../flow';
import { initialName, ProfileStep } from '../steps/ProfileStep';

const USER = 'user-1';
const mockRouter = { replace: jest.fn() };
const mockSession = {
  session: { user: { id: USER, user_metadata: { full_name: 'Avery Provider' } } } as {
    user: { id: string; user_metadata: Record<string, unknown> };
  },
  profile: { id: USER, display_name: '', driving_stage: 'unknown' } as {
    id: string;
    display_name: string;
    driving_stage: string;
  },
  refreshProfile: jest.fn(async () => {}),
};
const mockOrder: string[] = [];
const mockApi = {
  setBirthDate: jest.fn(async (_iso: string) => {
    mockOrder.push('setBirthDate');
    return 'set' as 'set' | 'already-set';
  }),
  writeOnboardingZone: jest.fn(async (_id: string) => {
    mockOrder.push('writeOnboardingZone');
    return true;
  }),
  readAgeBand: jest.fn(async (_id: string) => '18_plus'),
  readPrivateProfile: jest.fn(async (_id: string) => ({ birthDate: null as string | null })),
};
const mockUpdateOwnProfile = jest.fn(async (_id: string, _patch: unknown) => ({}));

jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
// The profile write is the M0 wrapper, watched here: the under-13 branch must never reach it.
jest.mock('@/data/supabase/profile', () => ({
  updateOwnProfile: (id: string, patch: unknown) => mockUpdateOwnProfile(id, patch),
  recordConsent: jest.fn(),
}));
jest.mock('../api', () => ({
  ...jest.requireActual('../api'),
  setBirthDate: (iso: string) => mockApi.setBirthDate(iso),
  writeOnboardingZone: (id: string) => mockApi.writeOnboardingZone(id),
  readAgeBand: (id: string) => mockApi.readAgeBand(id),
  readPrivateProfile: (id: string) => mockApi.readPrivateProfile(id),
}));

const ctx: FlowContext = {
  platform: 'android',
  ageBand: 'unknown',
  drivingStage: 'unknown',
  termsCurrent: true,
  termsPublished: false,
  minorConsentMode: 'guardian_link_optional',
  features: { autoDetect: true, guardianInvites: false },
};
const onNext = jest.fn();

async function renderStep() {
  await render(
    <ThemeProvider>
      <ProfileStep ctx={ctx} onNext={onNext} />
    </ThemeProvider>
  );
  // The saved birth date (or its absence) is read first.
  await waitFor(() => expect(mockApi.readPrivateProfile).toHaveBeenCalled());
}

async function typeDate(month: string, day: string, year: string) {
  await fireEvent.changeText(await screen.findByLabelText('Birth date, Month'), month);
  await fireEvent.changeText(screen.getByLabelText('Birth date, Day'), day);
  await fireEvent.changeText(screen.getByLabelText('Birth date, Year'), year);
}

async function fillValid() {
  await fireEvent.changeText(screen.getByLabelText('First name'), 'Sam');
  await typeDate('03', '04', '2008');
  await fireEvent.press(screen.getByRole('radio', { name: "Learner's permit" }));
}

const sheet = () => screen.queryByTestId('confirm-birth-date-value');

beforeEach(() => {
  onNext.mockClear();
  mockRouter.replace.mockClear();
  mockUpdateOwnProfile.mockReset().mockResolvedValue({});
  mockSession.refreshProfile.mockReset().mockResolvedValue(undefined);
  mockSession.profile = { id: USER, display_name: '', driving_stage: 'unknown' };
  mockSession.session = { user: { id: USER, user_metadata: { full_name: 'Avery Provider' } } };
  mockApi.setBirthDate.mockReset().mockImplementation(async () => {
    mockOrder.push('setBirthDate');
    return 'set';
  });
  mockApi.writeOnboardingZone.mockReset().mockImplementation(async () => {
    mockOrder.push('writeOnboardingZone');
    return true;
  });
  mockOrder.length = 0;
  mockApi.readAgeBand.mockReset().mockResolvedValue('18_plus');
  mockApi.readPrivateProfile.mockReset().mockResolvedValue({ birthDate: null });
});

describe('initialName (prefill precedence)', () => {
  it('the name already on the profile wins', () => {
    expect(initialName('Sam', { user_metadata: { full_name: 'Avery Provider' } })).toBe('Sam');
  });
  it("an empty profile name falls back to the provider's", () => {
    expect(initialName('', { user_metadata: { full_name: 'Avery Provider' } })).toBe('Avery Provider');
    expect(initialName('  ​ ', { user_metadata: { name: 'Avery' } })).toBe('Avery');
    expect(initialName(null, { user_metadata: { display_name: 'Ava', full_name: 'X' } })).toBe('Ava');
  });
  it('nothing anywhere is empty, and a long name is cut to 40', () => {
    expect(initialName(undefined, null)).toBe('');
    expect(Array.from(initialName('', { user_metadata: { name: 'x'.repeat(60) } }))).toHaveLength(40);
  });
});

describe('ProfileStep', () => {
  it('prefills the name from the provider, and starts with no date and no stage chosen', async () => {
    await renderStep();
    expect(screen.getByLabelText('First name').props.value).toBe('Avery Provider');
    expect(screen.getByLabelText('Birth date, Year').props.value).toBe('');
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.props.accessibilityLabel)).toEqual([
      "Learner's permit",
      'Licensed under 1 year',
      'Licensed 1 to 3 years',
      'Licensed 3 or more years',
      "I don't drive",
    ]);
    for (const r of radios) expect(r.props.accessibilityState).toMatchObject({ checked: false });
  });

  it('the stage chips behave as one radio group', async () => {
    await renderStep();
    await fireEvent.press(screen.getByRole('radio', { name: "Learner's permit" }));
    await fireEvent.press(screen.getByRole('radio', { name: "I don't drive" }));
    expect(screen.getByRole('radio', { name: "I don't drive" }).props.accessibilityState).toMatchObject({
      checked: true,
    });
    expect(
      screen.getByRole('radio', { name: "Learner's permit" }).props.accessibilityState
    ).toMatchObject({ checked: false });
  });

  it('Continue with something missing says what, and sends nothing', async () => {
    await renderStep();
    await fireEvent.changeText(screen.getByLabelText('First name'), '   ');
    await fireEvent.press(screen.getByTestId('profile-continue'));
    expect(screen.getByText('Enter your first name.')).toBeOnTheScreen();
    expect(screen.getByText('Enter your birth date as MM / DD / YYYY.')).toBeOnTheScreen();
    expect(screen.getByText('Choose the one that fits.')).toBeOnTheScreen();
    expect(sheet()).toBeNull();
    expect(mockApi.setBirthDate).not.toHaveBeenCalled();
  });

  it('a date that does not exist is caught before anything is sent', async () => {
    await renderStep();
    await typeDate('02', '30', '2008');
    expect(screen.getByText('Check the month and day.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('profile-continue'));
    expect(sheet()).toBeNull();
  });

  it('confirms the date, spelled out, before the write-once RPC', async () => {
    await renderStep();
    await fillValid();
    await fireEvent.press(screen.getByTestId('profile-continue'));
    expect(sheet()).toHaveTextContent('March 4, 2008');
    expect(screen.getByText('Is this right?')).toBeOnTheScreen();
    expect(screen.getByText("Your birth date can't be changed later.")).toBeOnTheScreen();
    expect(mockApi.setBirthDate).not.toHaveBeenCalled();
  });

  it('Edit closes the sheet and sends nothing', async () => {
    await renderStep();
    await fillValid();
    await fireEvent.press(screen.getByTestId('profile-continue'));
    await fireEvent.press(screen.getByRole('button', { name: 'Edit' }));
    expect(sheet()).toBeNull();
    expect(mockApi.setBirthDate).not.toHaveBeenCalled();
    expect(mockUpdateOwnProfile).not.toHaveBeenCalled();
  });

  it('backend m3: the zone is written BEFORE the birth date, so the band is derived on the driver’s own date', async () => {
    await renderStep();
    await fillValid();
    await fireEvent.press(screen.getByTestId('profile-continue'));
    await fireEvent.press(screen.getByRole('button', { name: "Yes, that's right" }));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(mockApi.writeOnboardingZone).toHaveBeenCalledWith(USER);
    expect(mockOrder).toEqual(['writeOnboardingZone', 'setBirthDate']);
  });

  it('backend m3: a zone that could not be written never holds the step back', async () => {
    mockApi.writeOnboardingZone.mockImplementation(async () => {
      mockOrder.push('writeOnboardingZone');
      return false;
    });
    await renderStep();
    await fillValid();
    await fireEvent.press(screen.getByTestId('profile-continue'));
    await fireEvent.press(screen.getByRole('button', { name: "Yes, that's right" }));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(mockApi.setBirthDate).toHaveBeenCalledWith('2008-03-04');
  });

  it('confirmed, not under 13: sets the date, saves the name and stage, refreshes, moves on', async () => {
    await renderStep();
    await fillValid();
    await fireEvent.press(screen.getByTestId('profile-continue'));
    await fireEvent.press(screen.getByRole('button', { name: "Yes, that's right" }));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(mockApi.setBirthDate).toHaveBeenCalledWith('2008-03-04');
    expect(mockUpdateOwnProfile).toHaveBeenCalledWith(USER, {
      display_name: 'Sam',
      driving_stage: 'permit',
    });
    expect(mockSession.refreshProfile).toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('confirmed, under 13: goes to the block and never writes the profile', async () => {
    mockApi.readAgeBand.mockResolvedValue('u13');
    await renderStep();
    await fillValid();
    await fireEvent.press(screen.getByTestId('profile-continue'));
    await fireEvent.press(screen.getByRole('button', { name: "Yes, that's right" }));
    await waitFor(() =>
      expect(mockRouter.replace).toHaveBeenCalledWith('/(onboarding)/not-eligible')
    );
    expect(mockApi.setBirthDate).toHaveBeenCalledWith('2008-03-04');
    expect(mockSession.refreshProfile).toHaveBeenCalled();
    expect(mockUpdateOwnProfile).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });

  it('already set on the account: carries on with the account’s band', async () => {
    mockApi.setBirthDate.mockResolvedValue('already-set');
    await renderStep();
    await fillValid();
    await fireEvent.press(screen.getByTestId('profile-continue'));
    await fireEvent.press(screen.getByRole('button', { name: "Yes, that's right" }));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(mockApi.readAgeBand).toHaveBeenCalledWith(USER);
  });

  it('a failed birth-date write says so in the sheet, and the same button tries again', async () => {
    mockApi.setBirthDate.mockRejectedValueOnce(new Error('offline'));
    await renderStep();
    await fillValid();
    await fireEvent.press(screen.getByTestId('profile-continue'));
    await fireEvent.press(screen.getByRole('button', { name: "Yes, that's right" }));
    expect(await screen.findByText("Couldn't save your birth date. Try again.")).toBeOnTheScreen();
    expect(onNext).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: "Yes, that's right" }));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(mockApi.setBirthDate).toHaveBeenCalledTimes(2);
  });

  it('a failure after the date is stored: the date is not asked again, Continue picks up', async () => {
    mockUpdateOwnProfile.mockRejectedValueOnce(new Error('offline'));
    await renderStep();
    await fillValid();
    await fireEvent.press(screen.getByTestId('profile-continue'));
    await fireEvent.press(screen.getByRole('button', { name: "Yes, that's right" }));
    expect(await screen.findByText("Couldn't save that. Try again.")).toBeOnTheScreen();
    expect(screen.getByTestId('birth-date-fixed')).toHaveTextContent(/March 4, 2008/);

    await fireEvent.press(screen.getByTestId('profile-continue'));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(mockApi.setBirthDate).toHaveBeenCalledTimes(1);
    expect(sheet()).toBeNull();
  });

  it('a birth date already on the account is shown read-only and never sent again', async () => {
    mockApi.readPrivateProfile.mockResolvedValue({ birthDate: '2001-02-03' });
    mockSession.profile = { id: USER, display_name: 'Sam', driving_stage: 'experienced' };
    await renderStep();
    expect(await screen.findByText('February 3, 2001')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Birth date, Month')).toBeNull();
    // The saved name and stage come back as they were.
    expect(screen.getByLabelText('First name').props.value).toBe('Sam');
    expect(
      screen.getByRole('radio', { name: 'Licensed 3 or more years' }).props.accessibilityState
    ).toMatchObject({ checked: true });

    await fireEvent.press(screen.getByTestId('profile-continue'));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(sheet()).toBeNull();
    expect(mockApi.setBirthDate).not.toHaveBeenCalled();
    expect(mockUpdateOwnProfile).toHaveBeenCalledWith(USER, {
      display_name: 'Sam',
      driving_stage: 'experienced',
    });
  });

  it('a failed read of the saved birth date says so, and Try again reads it again', async () => {
    mockApi.readPrivateProfile.mockRejectedValueOnce(new Error('offline'));
    await renderStep();
    expect(await screen.findByText("Couldn't load your details.")).toBeOnTheScreen();
    expect(screen.getByTestId('profile-continue').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Birth date, Month')).toBeOnTheScreen();
    expect(mockApi.readPrivateProfile).toHaveBeenCalledTimes(2);
  });
});

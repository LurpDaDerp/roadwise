/**
 * Emergency contacts: what is stored under `emergency.contacts` (cleaned, capped, malformed entries
 * skipped), the dialer link, the number as it reads, Settings › Emergency contacts with its sheet,
 * and Home's card.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { appWorld, clearQueryClients, memoryDb, tap } from '@/features/permissions/__fixtures__/harness';

import { emergencyCopy } from '../copy';
import { EmergencyContactsScreen } from '../EmergencyContactsScreen';
import {
  cleanPhone,
  contactProblem,
  EMERGENCY_CONTACTS_KEY,
  EMERGENCY_NUMBER,
  formatPhone,
  MAX_CONTACTS,
  newContactId,
  readContacts,
  telUrl,
  withContact,
  writeContacts,
  type EmergencyContact,
} from '../model';
import { removeContact, saveContact } from '../useEmergencyContacts';

const mockPush = jest.fn();
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: mockPush, canGoBack: () => true }),
  // Focus effects run once on mount here.
  useFocusEffect: (fn: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the real React inside a mock factory
    const { useEffect } = require('react') as typeof import('react');
    useEffect(() => fn(), [fn]);
  },
}));

const MOM: EmergencyContact = { id: 'contact-mom', name: 'Mom', phone: '5551234567' };
const contact = (i: number): EmergencyContact => ({ id: `contact-${i}`, name: `Person ${i}`, phone: `555000000${i}` });

beforeEach(() => mockPush.mockClear());
afterEach(() => clearQueryClients());

describe('stored contacts', () => {
  it('cleans a number to digits, keeping a leading +', () => {
    expect(cleanPhone(' (555) 123-4567 ')).toBe('5551234567');
    expect(cleanPhone('+1 555.123.4567')).toBe('+15551234567');
    expect(cleanPhone('*67 555#')).toBe('67555');
  });

  it('dials 911 and a cleaned number', () => {
    expect(EMERGENCY_NUMBER).toBe('911');
    expect(telUrl(EMERGENCY_NUMBER)).toBe('tel:911');
    expect(telUrl('+1 (555) 123-4567')).toBe('tel:+15551234567');
  });

  it('lays a number out for reading', () => {
    expect(formatPhone('5551234567')).toBe('(555) 123-4567');
    expect(formatPhone('+15551234567')).toBe('+1 (555) 123-4567');
    expect(formatPhone('15551234567')).toBe('1 (555) 123-4567');
    expect(formatPhone('1234567')).toBe('123-4567');
    expect(formatPhone('+442071234567')).toBe('+442071234567');
    expect(formatPhone('911')).toBe('911');
  });

  it('wants a name of up to 20 characters and 3 to 15 digits', () => {
    expect(contactProblem({ name: '  ', phone: '5551234567' })).toBe('name_empty');
    expect(contactProblem({ name: 'A'.repeat(21), phone: '5551234567' })).toBe('name_long');
    expect(contactProblem({ name: 'Mom', phone: '55' })).toBe('phone');
    expect(contactProblem({ name: 'Mom', phone: '+1234567890123456' })).toBe('phone');
    expect(contactProblem({ name: ' Mom ', phone: '(555) 123-4567' })).toBeNull();
  });

  it('reads them in the order added, skipping anything malformed and anything past 5', async () => {
    const settings = createSettingsRepo(memoryDb());
    await settings.set(EMERGENCY_CONTACTS_KEY, [MOM, 'junk', { id: 'x', name: '', phone: '5551234567' }, ...[1, 2, 3, 4, 5].map(contact)]);
    const list = await readContacts(settings);
    expect(list.map((c) => c.id)).toEqual(['contact-mom', 'contact-1', 'contact-2', 'contact-3', 'contact-4']);
    await settings.set(EMERGENCY_CONTACTS_KEY, { not: 'a list' });
    expect(await readContacts(settings)).toEqual([]);
  });

  it('writes names trimmed and numbers cleaned, and refuses a sixth contact or a bad one', async () => {
    const settings = createSettingsRepo(memoryDb());
    await writeContacts(settings, [{ ...MOM, name: ' Mom ', phone: '(555) 123-4567' }]);
    expect(await readContacts(settings)).toEqual([MOM]);
    const six = [1, 2, 3, 4, 5, 6].map(contact);
    expect(MAX_CONTACTS).toBe(5);
    await expect(writeContacts(settings, six)).rejects.toThrow('too_many');
    await expect(writeContacts(settings, [{ ...MOM, phone: '1' }])).rejects.toThrow('phone');
    expect(await readContacts(settings)).toEqual([MOM]);
  });

  it('saves a new contact at the end, edits one in place, and removes one', async () => {
    const settings = createSettingsRepo(memoryDb());
    await saveContact(settings, MOM);
    await saveContact(settings, contact(1));
    expect((await saveContact(settings, { ...MOM, name: 'Mama' })).map((c) => c.name)).toEqual(['Mama', 'Person 1']);
    expect(withContact([MOM], contact(2)).map((c) => c.id)).toEqual(['contact-mom', 'contact-2']);
    expect(await removeContact(settings, 'contact-mom')).toEqual([contact(1)]);
    expect(newContactId(1)).toMatch(/^contact-1-[a-z0-9]+$/);
  });
});

/** Types into the sheet's two fields. */
async function fill(name: string, phone: string) {
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('contact-name'), name);
  });
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('contact-phone'), phone);
  });
}

describe('Settings › Emergency contacts', () => {
  it('says what it is for and that 911 always comes first', async () => {
    const w = await appWorld();
    await w.render(<EmergencyContactsScreen />);
    expect(await screen.findByText(emergencyCopy.intro)).toBeOnTheScreen();
    expect(emergencyCopy.intro).toBe('Add up to 5 people to call from the driving screen. They stay on this phone.');
    expect(screen.getByTestId('emergency-always')).toHaveTextContent("911 is always on the call list while you drive, so you don't need to add it.");
    expect(screen.queryByTestId('emergency-list')).toBeNull();
  });

  it('adds a contact, with the phone keyboard and the phone AutoFill', async () => {
    const w = await appWorld();
    await w.render(<EmergencyContactsScreen />);
    await waitFor(() => expect(screen.getByTestId('emergency-add')).toBeEnabled());
    await tap('emergency-add');
    const phone = screen.getByTestId('contact-phone');
    expect(phone.props.keyboardType).toBe('phone-pad');
    expect(phone.props.textContentType).toBe('telephoneNumber');
    await fill('Mom', '(555) 123-4567');
    await tap('contact-save');
    await waitFor(async () => expect(await readContacts(w.settings)).toEqual([expect.objectContaining({ name: 'Mom', phone: '5551234567' })]));
    const row = await screen.findByText('Mom');
    expect(row).toBeOnTheScreen();
    expect(within(screen.getByTestId('emergency-list')).getByText('(555) 123-4567')).toBeOnTheScreen();
  });

  it('says what is wrong and saves nothing until it is right', async () => {
    const w = await appWorld();
    await w.render(<EmergencyContactsScreen />);
    await waitFor(() => expect(screen.getByTestId('emergency-add')).toBeEnabled());
    await tap('emergency-add');
    await fill('', '5551234567');
    await tap('contact-save');
    expect(await screen.findByTestId('contact-problem')).toHaveTextContent(emergencyCopy.sheet.problems.name_empty);
    await fill('Mom', '12');
    await tap('contact-save');
    expect(await screen.findByTestId('contact-problem')).toHaveTextContent(emergencyCopy.sheet.problems.phone);
    expect(await readContacts(w.settings)).toEqual([]);
  });

  it('edits a contact in its sheet', async () => {
    const w = await appWorld({ settings: { [EMERGENCY_CONTACTS_KEY]: [MOM] } });
    await w.render(<EmergencyContactsScreen />);
    await tap('emergency-contact-contact-mom');
    expect(screen.getByTestId('contact-name').props.value).toBe('Mom');
    await fill('Mama', '+1 555 999 0000');
    await tap('contact-save');
    await waitFor(async () => expect(await readContacts(w.settings)).toEqual([{ id: 'contact-mom', name: 'Mama', phone: '+15559990000' }]));
  });

  it('removes a contact after a check', async () => {
    const w = await appWorld({ settings: { [EMERGENCY_CONTACTS_KEY]: [MOM] } });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => buttons?.find((b) => b.style === 'destructive')?.onPress?.());
    await w.render(<EmergencyContactsScreen />);
    await tap('emergency-contact-contact-mom');
    await tap('contact-remove');
    expect(alert).toHaveBeenCalledWith('Remove Mom?', emergencyCopy.sheet.removeBody, expect.anything());
    await waitFor(async () => expect(await readContacts(w.settings)).toEqual([]));
    alert.mockRestore();
  });

  it('turns Add a contact off at 5, with a line saying so', async () => {
    const w = await appWorld({ settings: { [EMERGENCY_CONTACTS_KEY]: [1, 2, 3, 4, 5].map(contact) } });
    await w.render(<EmergencyContactsScreen />);
    expect(await screen.findByText(emergencyCopy.max)).toBeOnTheScreen();
    expect(screen.getByTestId('emergency-add')).toBeDisabled();
  });

  it('copy is plain: no dashes, no exclamation marks', () => {
    const words = JSON.stringify(emergencyCopy, (_k, v: unknown) => (typeof v === 'function' ? (v as (...a: string[]) => string)('Mom', '(555) 123-4567') : v));
    expect(words).not.toMatch(/[–—!]/);
  });
});

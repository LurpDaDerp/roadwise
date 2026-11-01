// The driving screen's crash screen keeps the emergency button: a tap opens the emergency panel in
// place of the words, and Call 911 hands tel:911 to the phone, even when the contacts can't be read.
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { Linking } from 'react-native';

import type { EmergencyContact } from '@/features/emergency/model';

import { HudCrashed } from '../HudCrashed';
import { hudCopy } from '../hudCopy';

jest.mock('@/lib/crashReport', () => ({ reportError: jest.fn() }));

let mockContacts: EmergencyContact[] | 'throw' = 'throw';
jest.mock('@/features/emergency/useEmergencyContacts', () => ({
  useEmergencyContacts: () => {
    if (mockContacts === 'throw') throw new Error('no data provider');
    return { contacts: mockContacts };
  },
}));

const renderCrashed = () => render(<HudCrashed error={new Error('render failed')} retry={jest.fn(async () => {})} />);

beforeEach(() => {
  mockContacts = 'throw';
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

test('the emergency button stays on the crash screen beside Try again', async () => {
  await renderCrashed();
  expect(screen.getByTestId('hud-crashed-retry')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: hudCopy.sos.label })).toHaveProp('accessibilityHint', hudCopy.sos.hint);
});

test('a tap opens the panel; Call 911 hands tel:911 to the phone and closes it, even when the contacts cannot be read', async () => {
  await renderCrashed();
  await fireEvent.press(screen.getByTestId('hud-sos'));
  const sheet = screen.getByTestId('hud-crashed-sos-sheet');
  expect(within(sheet).getByTestId('hud-sos-911')).toBeOnTheScreen();
  expect(screen.queryByTestId('hud-crashed-retry')).toBeNull();
  await fireEvent.press(screen.getByTestId('hud-sos-911'));
  await act(async () => {});
  expect(Linking.openURL).toHaveBeenCalledWith('tel:911');
  expect(screen.queryByTestId('hud-crashed-sos-sheet')).toBeNull();
  expect(screen.getByTestId('hud-crashed-retry')).toBeOnTheScreen();
});

test('with the contacts read, they follow Call 911; Close brings Try again back', async () => {
  mockContacts = [{ id: 'contact-1', name: 'Mom', phone: '+15551234567' }];
  await renderCrashed();
  await fireEvent.press(screen.getByTestId('hud-sos'));
  await fireEvent.press(screen.getByRole('button', { name: 'Call Mom, +1 (555) 123-4567' }));
  await act(async () => {});
  expect(Linking.openURL).toHaveBeenLastCalledWith('tel:+15551234567');
  await fireEvent.press(screen.getByTestId('hud-sos'));
  await fireEvent.press(screen.getByTestId('hud-sos-close'));
  expect(screen.queryByTestId('hud-crashed-sos-sheet')).toBeNull();
  expect(screen.getByTestId('hud-crashed-retry')).toBeOnTheScreen();
});

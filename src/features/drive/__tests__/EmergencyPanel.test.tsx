// The emergency panel picks its tall layout (title, "Call 911" and Close pinned, the contacts
// scrolling between) only when a whole contact row fits at the text size in use; otherwise the title
// is only read out and everything scrolls as one list, "Call 911" first.
import { render, screen } from '@testing-library/react-native';

import type { EmergencyContact } from '@/features/emergency/model';
import { hudLayout } from '@/features/drive/hudLayout';
import { hudPalette } from '@/ui/drive';

import { EmergencyPanel, sosPanelTall } from '../EmergencyPanel';
import { hudCopy } from '../hudCopy';

const COLORS = { surface: '#1C1C1E', ink: '#F2F2F7', muted: '#AEAEB2', edge: '#3A3A3C' };
const mom: EmergencyContact = { id: 'contact-1', name: 'Mom', phone: '+15551234567' };

const mockWindow = jest.fn(() => ({ width: 375, height: 667, scale: 2, fontScale: 1 }));
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockWindow() }));
const windowAt = (fontScale: number) => mockWindow.mockReturnValue({ width: 375, height: 667, scale: 2, fontScale });

const renderPanel = (height: number) =>
  render(<EmergencyPanel contacts={[mom]} palette={hudPalette(false)} colors={COLORS} height={height} onCall={jest.fn(async () => true)} onClose={jest.fn()} />);

const SE = hudLayout({ width: 375, height: 667, insets: { top: 20, bottom: 0, left: 0, right: 0 }, fontScale: 1, chip: false, units: 'mi' });
const PRO = hudLayout({ width: 393, height: 852, insets: { top: 59, bottom: 34, left: 0, right: 0 }, fontScale: 1, chip: false, units: 'mi' });

test.each([1, 2])('an iPhone SE in portrait (a %sx font scale): one scrolling list, "Call 911" first, the title only read out', async (fontScale) => {
  windowAt(fontScale);
  await renderPanel(SE.sosPanel.h);
  expect(screen.queryByRole('header')).toBeNull();
  expect(screen.getByTestId('hud-sos-panel').type).toBe('RCTScrollView');
  expect(screen.getAllByRole('button').map((b) => b.props.testID)).toEqual(['hud-sos-911', 'hud-sos-contact-contact-1', 'hud-sos-close']);
});

test('a large phone keeps the title with "Call 911" and Close pinned', async () => {
  windowAt(1);
  await renderPanel(PRO.sosPanel.h);
  expect(screen.getByRole('header')).toHaveTextContent(hudCopy.sos.title);
});

test('the switch follows the text size: a panel tall enough at 1x is short at 2x', () => {
  expect(sosPanelTall(275, 1)).toBe(false);
  expect(sosPanelTall(320, 1)).toBe(true);
  expect(sosPanelTall(320, 2)).toBe(false);
  expect(sosPanelTall(440, 2)).toBe(true);
  // the text keeps growing past 2x, and the bar with it
  expect(sosPanelTall(440, 3.1)).toBe(false);
  // a font scale under 1 is treated as 1
  expect(sosPanelTall(275, 0.8)).toBe(false);
});

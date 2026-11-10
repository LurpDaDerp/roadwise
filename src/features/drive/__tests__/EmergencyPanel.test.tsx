// The emergency panel's layout. With contacts to show it picks the tall one (title, "Call 911" and
// Close pinned, the contacts scrolling between) only when a whole contact row fits at the text size
// in use; with none it picks it from 260 pt up. Otherwise the title is only read out and everything
// scrolls as one list, "Call 911" first.
import { render, screen } from '@testing-library/react-native';

import type { EmergencyContact } from '@/features/emergency/model';
import { hudLayout } from '@/features/drive/hudLayout';
import { hudPalette } from '@/ui/drive';

import { EmergencyPanel, SOS_PANEL_TALL_PT, sosPanelTall } from '../EmergencyPanel';
import { hudCopy } from '../hudCopy';

const COLORS = { surface: '#1C1C1E', ink: '#F2F2F7', muted: '#AEAEB2', edge: '#3A3A3C' };
const mom: EmergencyContact = { id: 'contact-1', name: 'Mom', phone: '+15551234567' };

const mockWindow = jest.fn(() => ({ width: 375, height: 667, scale: 2, fontScale: 1 }));
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockWindow() }));
const windowAt = (fontScale: number) => mockWindow.mockReturnValue({ width: 375, height: 667, scale: 2, fontScale });

const SE = hudLayout({ width: 375, height: 667, insets: { top: 20, bottom: 0, left: 0, right: 0 }, fontScale: 1, chip: false, units: 'mi' }).sosPanel;
const PRO = hudLayout({ width: 393, height: 852, insets: { top: 59, bottom: 34, left: 0, right: 0 }, fontScale: 1, chip: false, units: 'mi' }).sosPanel;
const MAX = hudLayout({ width: 430, height: 932, insets: { top: 59, bottom: 34, left: 0, right: 0 }, fontScale: 1, chip: false, units: 'mi' }).sosPanel;

const renderPanel = (slot: { w: number; h: number }, contacts: readonly EmergencyContact[] | undefined) =>
  render(<EmergencyPanel contacts={contacts} palette={hudPalette(false)} colors={COLORS} height={slot.h} width={slot.w} onCall={jest.fn(async () => true)} onClose={jest.fn()} />);

const buttons = () => screen.getAllByRole('button').map((b) => b.props.testID);

test.each([1, 2])('an iPhone SE in portrait with a contact (a %sx font scale): one scrolling list, "Call 911" first, the title only read out', async (fontScale) => {
  windowAt(fontScale);
  await renderPanel(SE, [mom]);
  expect(screen.queryByRole('header')).toBeNull();
  expect(screen.getByTestId('hud-sos-panel').type).toBe('RCTScrollView');
  expect(buttons()).toEqual(['hud-sos-911', 'hud-sos-contact-contact-1', 'hud-sos-close']);
});

test.each([1, 2])('an iPhone SE in portrait with no contacts (a %sx font scale): the title with "Call 911" and Close pinned', async (fontScale) => {
  windowAt(fontScale);
  await renderPanel(SE, []);
  expect(screen.getByRole('header')).toHaveTextContent(hudCopy.sos.title);
  expect(screen.getByTestId('hud-sos-panel').type).toBe('View');
  expect(screen.getByTestId('hud-sos-none')).toHaveTextContent(hudCopy.sos.none);
  expect(buttons()).toEqual(['hud-sos-911', 'hud-sos-close']);
});

test('an iPhone SE in portrait while the contacts are still being read: the title with "Call 911" and Close pinned', async () => {
  windowAt(1);
  await renderPanel(SE, undefined);
  expect(screen.getByRole('header')).toHaveTextContent(hudCopy.sos.title);
  expect(screen.queryByTestId('hud-sos-none')).toBeNull();
  expect(buttons()).toEqual(['hud-sos-911', 'hud-sos-close']);
});

test('a window under 260 pt with no contacts: one scrolling list, the title only read out', async () => {
  windowAt(1);
  await renderPanel({ w: SE.w, h: SOS_PANEL_TALL_PT - 1 }, []);
  expect(screen.queryByRole('header')).toBeNull();
  expect(screen.getByTestId('hud-sos-panel').type).toBe('RCTScrollView');
  expect(buttons()).toEqual(['hud-sos-911', 'hud-sos-close']);
});

test.each([1, 1.786, 2.143])('a large phone with a contact keeps the title with "Call 911" and Close pinned (a %sx font scale)', async (fontScale) => {
  windowAt(fontScale);
  await renderPanel(PRO, [mom]);
  expect(screen.getByRole('header')).toHaveTextContent(hudCopy.sos.title);
  expect(buttons()).toEqual(['hud-sos-911', 'hud-sos-contact-contact-1', 'hud-sos-close']);
});

test('with no contact rows the switch is 260 pt, whatever the text size or width', () => {
  expect(SOS_PANEL_TALL_PT).toBe(260);
  for (const fontScale of [0.8, 1, 2, 3.571]) {
    for (const width of [200, 343, 462]) {
      expect(sosPanelTall(259, width, fontScale, false)).toBe(false);
      expect(sosPanelTall(260, width, fontScale, false)).toBe(true);
    }
  }
});

test('with contact rows the switch follows the text size: a panel tall enough at 1x is short at 2x', () => {
  expect(sosPanelTall(275, 343, 1, true)).toBe(false);
  // 28 title + 72 "Call 911" + 67 row + 56 Close + 36 between them + 34 around
  expect(sosPanelTall(292, 343, 1, true)).toBe(false);
  expect(sosPanelTall(293, 343, 1, true)).toBe(true);
  expect(sosPanelTall(320, 343, 2, true)).toBe(false);
  expect(sosPanelTall(440, 343, 2, true)).toBe(true);
  // the text keeps growing past 2x, and "Call 911" and Close with it
  expect(sosPanelTall(440, 343, 3.1, true)).toBe(false);
  // a font scale under 1 is treated as 1
  expect(sosPanelTall(292, 343, 0.8, true)).toBe(false);
  expect(sosPanelTall(293, 343, 0.8, true)).toBe(true);
  expect(sosPanelTall(293, 343, Number.NaN, true)).toBe(true);
});

test('the title counts as two lines only where it wraps: at the width and text size in use', () => {
  // the widths are the title's own, in its face: a new title needs them measured again
  expect(hudCopy.sos.title).toBe('Emergency call');
  // one line on every iPhone in portrait up to 2.143x (135 pt wide at 1x, in 309 pt or more)
  expect(sosPanelTall(PRO.h, PRO.w, 1.786, true)).toBe(true);
  expect(sosPanelTall(PRO.h, PRO.w, 2.143, true)).toBe(true);
  // at 2.643x it still fits one line in the widest phones' panel, and wraps in a narrower one
  expect(sosPanelTall(MAX.h, MAX.w, 2.643, true)).toBe(true);
  expect(sosPanelTall(MAX.h, PRO.w, 2.643, true)).toBe(false);
  // a second line costs its height: 2 x 74 pt where one line left room to spare
  expect(sosPanelTall(MAX.h + 74, PRO.w, 2.643, true)).toBe(true);
  expect(sosPanelTall(MAX.h, 0, 1, true)).toBe(false);
});

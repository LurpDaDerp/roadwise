// "Choose your navigation app": only Cancel / Close is pinned, everything else scrolls as one list,
// so a short driving-screen panel (an iPhone SE in portrait) always reaches the first app.
import { render, screen, within } from '@testing-library/react-native';

import { hudLayout } from '@/features/drive/hudLayout';
import { navCopy } from '@/features/navigation/copy';
import { NAV_ROW_MIN_PT, NavAppPicker } from '@/features/navigation/NavAppPicker';
import { PANEL_CAPSULE_PT } from '@/ui/drive/panelLook';

const COLORS = { surface: '#FFFFFF', ink: '#111113', muted: '#555555', edge: '#DDDDDD' };
const APPS = [
  { id: 'apple_maps', label: 'Apple Maps', target: 'maps://' },
  { id: 'waze', label: 'Waze', target: 'waze://' },
] as const;

function renderPicker(props: Partial<Parameters<typeof NavAppPicker>[0]> = {}) {
  return render(
    <NavAppPicker apps={APPS} mode="first" driveLine colors={COLORS} onChoose={jest.fn()} onClose={jest.fn()} {...props} />
  );
}

const hostChildIds = (id: string) =>
  screen
    .getByTestId(id)
    .children.map((c) => (typeof c === 'string' ? c : c.props.testID));

test.each(['first', 'failed', 'gone'] as const)('%s: only the close capsule is pinned; the title, notice, rows and footer scroll', async (mode) => {
  await renderPicker({ mode, missingLabel: 'Google Maps' });
  expect(hostChildIds('nav-picker')).toEqual(['nav-picker-scroll', 'nav-picker-close']);
  const scroll = screen.getByTestId('nav-picker-scroll');
  expect(within(scroll).getByRole('header')).toHaveTextContent(navCopy.pickerTitle);
  expect(within(scroll).getByTestId('nav-picker-row-apple_maps')).toBeOnTheScreen();
  expect(within(scroll).getByText(navCopy.footer)).toBeOnTheScreen();
  if (mode !== 'first') expect(within(scroll).getByTestId('nav-picker-notice')).toBeOnTheScreen();
});

test('on the driving screen the drive line sits under the title, with a gone / failed notice under it', async () => {
  const view = await renderPicker();
  expect(screen.getByText(navCopy.driveLine)).toBeOnTheScreen();
  await view.rerender(<NavAppPicker apps={APPS} mode="failed" missingLabel="Waze" driveLine colors={COLORS} onChoose={jest.fn()} onClose={jest.fn()} />);
  expect(screen.getByTestId('nav-picker-notice')).toHaveTextContent("Waze didn't open.");
  expect(screen.getByText(navCopy.driveLine)).toBeOnTheScreen();
  await view.rerender(<NavAppPicker apps={APPS} mode="gone" missingLabel="Waze" driveLine colors={COLORS} onChoose={jest.fn()} onClose={jest.fn()} />);
  expect(screen.getByTestId('nav-picker-notice')).toHaveTextContent("Waze isn't on this phone anymore.");
  expect(screen.getByText(navCopy.driveLine)).toBeOnTheScreen();
});

test('an iPhone SE in portrait: the list keeps a scrolling window at least a row tall above the pinned Cancel', () => {
  const l = hudLayout({ width: 375, height: 667, insets: { top: 20, bottom: 0, left: 0, right: 0 }, fontScale: 1, chip: false, units: 'mi' });
  const inner = l.panel.h - 2 * (16 + 1); // HudScreen's panel padding and border
  const window = inner - 12 - PANEL_CAPSULE_PT; // the gap and the pinned Cancel
  expect(window).toBeGreaterThanOrEqual(NAV_ROW_MIN_PT);
});

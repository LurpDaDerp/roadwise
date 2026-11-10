// "Where to?" (round 14): a row per saved place, then "Open {app}", then Cancel; 64 pt rows. Only
// Cancel is pinned, so a short driving-screen panel (an iPhone SE, larger text) reaches the first place.
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type { SavedPlace } from '@/features/places/model';
import { navCopy } from '@/features/navigation/copy';
import { hudLayout } from '@/features/drive/hudLayout';
import { NAV_ROW_MIN_PT } from '@/features/navigation/NavAppPicker';
import { NavPlacesPicker, placeSubtitle } from '@/features/navigation/NavPlacesPicker';
import { PANEL_CAPSULE_PT } from '@/ui/drive/panelLook';

const COLORS = { surface: '#FFFFFF', ink: '#111113', muted: '#555555', edge: '#DDDDDD' };
const WAZE = { id: 'waze', label: 'Waze', target: 'waze://' } as const;
const home: SavedPlace = { id: 'home', kind: 'home', name: 'Home', address: '12 Oak St', area: 'Seattle, WA 98104', lat: 47.6, lng: -122.3 };
const work: SavedPlace = { id: 'work', kind: 'work', name: 'Work', address: '', area: 'Bellevue, WA', lat: 47.61, lng: -122.2 };
const gym: SavedPlace = { id: 'place-abc', kind: 'custom', name: 'Climbing gym downtown', address: '', area: '', lat: 47.62, lng: -122.33 };

function renderList(places: SavedPlace[] = [home, work, gym]) {
  const onGo = jest.fn();
  const onOpenApp = jest.fn();
  const onClose = jest.fn();
  return { onGo, onOpenApp, onClose, view: render(<NavPlacesPicker app={WAZE} places={places} colors={COLORS} onGo={onGo} onOpenApp={onOpenApp} onClose={onClose} />) };
}

test('the title, the drive line, a row per place in order, then "Open Waze", then Cancel', async () => {
  const { view } = renderList();
  await view;
  expect(screen.getByRole('header')).toHaveTextContent('Where to?');
  expect(screen.getByText('Your drive keeps recording while you navigate.')).toBeOnTheScreen();
  expect(
    within(screen.getByTestId('nav-picker'))
      .getAllByRole('button')
      .map((b) => b.props.testID)
  ).toEqual(['nav-picker-place-home', 'nav-picker-place-work', 'nav-picker-place-place-abc', 'nav-picker-open-app', 'nav-picker-close']);
  expect(within(screen.getByTestId('nav-picker-open-app')).getByText('Open Waze')).toBeOnTheScreen();
  expect(within(screen.getByTestId('nav-picker-close')).getByText('Cancel')).toBeOnTheScreen();
  // no app rows and no Settings footer in this list
  expect(screen.queryByText(navCopy.footer)).toBeNull();
  expect(screen.queryByTestId('nav-picker-row-waze')).toBeNull();
});

test('each row: the name, the address under it (else the city line, else nothing); the screen reader hears both and what a tap does', async () => {
  const { view } = renderList();
  await view;
  const h = screen.getByTestId('nav-picker-place-home');
  expect(within(h).getByText('Home')).toBeOnTheScreen();
  expect(within(h).getByText('12 Oak St')).toBeOnTheScreen();
  expect(within(screen.getByTestId('nav-picker-place-work')).getByText('Bellevue, WA')).toBeOnTheScreen();
  expect(h).toHaveProp('accessibilityLabel', 'Directions to Home, 12 Oak St');
  expect(h).toHaveProp('accessibilityHint', navCopy.placeHint('Waze'));
  expect(screen.getByTestId('nav-picker-place-work')).toHaveProp('accessibilityLabel', 'Directions to Work, Bellevue, WA');
  const g = screen.getByTestId('nav-picker-place-place-abc');
  expect(within(g).getByText('Climbing gym downtown')).toBeOnTheScreen();
  // no second line at all
  expect(within(g).getAllByText(/./).filter((t) => typeof t.props.children === 'string' && t.props.children.length > 1)).toHaveLength(1);
  expect(screen.getByTestId('nav-picker-place-place-abc')).toHaveProp('accessibilityLabel', 'Directions to Climbing gym downtown');
  expect(screen.getByRole('button', { name: 'Open Waze' })).toBeOnTheScreen();
  expect(placeSubtitle({ address: '  ', area: ' Tacoma ' })).toBe('Tacoma');
  expect(placeSubtitle({ address: '', area: '' })).toBe('');
});

test('a row tap hands over its place; "Open Waze" and Cancel their own', async () => {
  const { view, onGo, onOpenApp, onClose } = renderList();
  await view;
  await fireEvent.press(screen.getByTestId('nav-picker-place-work'));
  expect(onGo).toHaveBeenCalledWith(work);
  await fireEvent.press(screen.getByTestId('nav-picker-open-app'));
  expect(onOpenApp).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByTestId('nav-picker-close'));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onGo).toHaveBeenCalledTimes(1);
});

test('every row is at least 64 pt tall', async () => {
  const { view } = renderList();
  await view;
  expect(NAV_ROW_MIN_PT).toBe(64);
  for (const id of ['nav-picker-place-home', 'nav-picker-place-work', 'nav-picker-place-place-abc', 'nav-picker-open-app']) {
    const style = StyleSheet.flatten(screen.getByTestId(id).props.style) as { minHeight: number };
    expect(style.minHeight).toBeGreaterThanOrEqual(64);
  }
});

test('the full ten places still end with "Open Waze" in the same scrolling list', async () => {
  const many: SavedPlace[] = Array.from({ length: 10 }, (_, i) => ({ ...gym, id: `place-${i}`, name: `Place ${i}` }));
  const { view } = renderList(many);
  await view;
  const list = screen.getByTestId('nav-picker-places');
  const ids = within(list)
    .getAllByRole('button')
    .map((b) => b.props.testID);
  expect(ids).toHaveLength(11);
  expect(ids.at(-1)).toBe('nav-picker-open-app');
});

const hostChildIds = (id: string) =>
  screen
    .getByTestId(id)
    .children.map((c) => (typeof c === 'string' ? c : c.props.testID));

test('only Cancel is pinned; the title, the drive line, the places and "Open Waze" scroll as one list', async () => {
  const { view } = renderList();
  await view;
  expect(hostChildIds('nav-picker')).toEqual(['nav-picker-scroll', 'nav-picker-close']);
  const scroll = screen.getByTestId('nav-picker-scroll');
  expect(within(scroll).getByRole('header')).toHaveTextContent(navCopy.placesTitle);
  expect(within(scroll).getByText(navCopy.driveLine)).toBeOnTheScreen();
  expect(within(scroll).getByTestId('nav-picker-place-home')).toBeOnTheScreen();
  expect(within(scroll).getByTestId('nav-picker-open-app')).toBeOnTheScreen();
  expect(StyleSheet.flatten(scroll.props.style)).toMatchObject({ flexGrow: 0, flexShrink: 1 });
});

test('an iPhone SE in portrait: the list keeps a scrolling window at least a row tall above the pinned Cancel', () => {
  const l = hudLayout({ width: 375, height: 667, insets: { top: 20, bottom: 0, left: 0, right: 0 }, fontScale: 1, chip: false, units: 'mi' });
  const inner = l.panel.h - 2 * (16 + 1); // HudScreen's panel padding and border
  const window = inner - 12 - PANEL_CAPSULE_PT; // the gap and the pinned Cancel
  expect(window).toBeGreaterThanOrEqual(NAV_ROW_MIN_PT);
});

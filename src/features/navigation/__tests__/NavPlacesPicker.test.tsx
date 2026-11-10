// "Where to?" (round 14): a row per saved place, then "Open {app}", then Cancel; 64 pt rows. The
// title and the drive line stay put above the rows' own scrolling window. Where that window cannot
// hold one whole row the list is short: only Cancel is pinned and everything else scrolls as one list.
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { ScrollView, StyleSheet } from 'react-native';

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

/** The root's children in order: a test ID, or 'header' for the title and the drive line. */
const rootChildren = () =>
  screen.getByTestId('nav-picker').children.map((c) => {
    if (typeof c === 'string') return c;
    if (typeof c.props.testID === 'string') return c.props.testID;
    return within(c).queryByRole('header') !== null ? 'header' : 'other';
  });

/** The rows' window reports its height. */
const measureRows = (height: number) =>
  fireEvent(screen.getByTestId('nav-picker-places'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 320, height } } });

const ROW_IDS = ['nav-picker-place-home', 'nav-picker-place-work', 'nav-picker-place-place-abc', 'nav-picker-open-app'];

test('the title and the drive line stay put; only the places and "Open Waze" scroll', async () => {
  const { view } = renderList();
  await view;
  expect(rootChildren()).toEqual(['header', 'nav-picker-places', 'nav-picker-close']);
  expect(screen.queryByTestId('nav-picker-scroll')).toBeNull();
  const rows = screen.getByTestId('nav-picker-places');
  expect(within(rows).getAllByRole('button').map((b) => b.props.testID)).toEqual(ROW_IDS);
  expect(within(rows).queryByRole('header')).toBeNull();
  expect(within(rows).queryByText(navCopy.driveLine)).toBeNull();
  // 12 pt between the parts, 8 pt between the rows; the window gives way first when the panel is short
  expect(StyleSheet.flatten(screen.getByTestId('nav-picker').props.style)).toMatchObject({ gap: 12, flexShrink: 1 });
  expect(StyleSheet.flatten(rows.props.style)).toMatchObject({ flexGrow: 0, flexShrink: 1 });
  expect(StyleSheet.flatten(rows.props.contentContainerStyle)).toEqual({ gap: 8 });
});

test('a rows window a whole row tall or more keeps that layout', async () => {
  const { view } = renderList();
  await view;
  await measureRows(NAV_ROW_MIN_PT + 21);
  await measureRows(NAV_ROW_MIN_PT);
  expect(rootChildren()).toEqual(['header', 'nav-picker-places', 'nav-picker-close']);
});

test('a rows window under one row turns the list short: only Cancel is pinned and the rest scrolls as one list', async () => {
  const { view } = renderList();
  await view;
  await measureRows(NAV_ROW_MIN_PT - 9);
  expect(rootChildren()).toEqual(['nav-picker-scroll', 'nav-picker-close']);
  const scroll = screen.getByTestId('nav-picker-scroll');
  expect(within(scroll).getByRole('header')).toHaveTextContent(navCopy.placesTitle);
  expect(within(scroll).getByText(navCopy.driveLine)).toBeOnTheScreen();
  expect(within(screen.getByTestId('nav-picker-places')).getAllByRole('button').map((b) => b.props.testID)).toEqual(ROW_IDS);
  expect(StyleSheet.flatten(scroll.props.style)).toMatchObject({ flexGrow: 0, flexShrink: 1 });
  expect(StyleSheet.flatten(scroll.props.contentContainerStyle)).toEqual({ gap: 12 });
  expect(StyleSheet.flatten(screen.getByTestId('nav-picker-places').props.style)).toEqual({ gap: 8 });
});

test('a short list stays short for as long as it is on screen, and its rows still work; a new one starts over', async () => {
  const { view, onGo, onOpenApp, onClose } = renderList();
  const shown = await view;
  await measureRows(0);
  expect(rootChildren()).toEqual(['nav-picker-scroll', 'nav-picker-close']);
  // a later, roomier measure of anything in it changes nothing, nor does a new set of places
  await fireEvent(screen.getByTestId('nav-picker-scroll'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 400 } } });
  await fireEvent(screen.getByTestId('nav-picker-places'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 400 } } });
  expect(rootChildren()).toEqual(['nav-picker-scroll', 'nav-picker-close']);
  await shown.rerender(<NavPlacesPicker app={WAZE} places={[home]} colors={COLORS} onGo={onGo} onOpenApp={onOpenApp} onClose={onClose} />);
  expect(rootChildren()).toEqual(['nav-picker-scroll', 'nav-picker-close']);
  expect(screen.queryByTestId('nav-picker-place-work')).toBeNull();
  await fireEvent.press(screen.getByTestId('nav-picker-place-home'));
  expect(onGo).toHaveBeenCalledWith(home);
  await fireEvent.press(screen.getByTestId('nav-picker-open-app'));
  expect(onOpenApp).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByTestId('nav-picker-close'));
  expect(onClose).toHaveBeenCalledTimes(1);
  await shown.unmount();
  const again = renderList();
  await again.view;
  expect(rootChildren()).toEqual(['header', 'nav-picker-places', 'nav-picker-close']);
});

describe('the rows window measured as it mounts', () => {
  type Window = NonNullable<ReturnType<ScrollView['getNativeScrollRef']>>;
  const nativeWindow = jest.mocked(ScrollView.prototype.getNativeScrollRef);
  const mountsAt = (width: number, height: number) => {
    const measure: Window['measure'] = (done) => done(0, 0, width, height, 0, 0);
    nativeWindow.mockReturnValue({ measure } as Window);
  };
  afterEach(() => {
    nativeWindow.mockReset();
  });

  test('under one row: the list is short from the start, with no layout report', async () => {
    mountsAt(320, NAV_ROW_MIN_PT - 9);
    await renderList().view;
    expect(rootChildren()).toEqual(['nav-picker-scroll', 'nav-picker-close']);
    const scroll = screen.getByTestId('nav-picker-scroll');
    expect(within(scroll).getByRole('header')).toHaveTextContent(navCopy.placesTitle);
    expect(within(scroll).getByText(navCopy.driveLine)).toBeOnTheScreen();
    expect(within(screen.getByTestId('nav-picker-places')).getAllByRole('button').map((b) => b.props.testID)).toEqual(ROW_IDS);
  });

  test('a whole row or more: the title and the drive line stay put', async () => {
    mountsAt(320, NAV_ROW_MIN_PT);
    await renderList().view;
    expect(rootChildren()).toEqual(['header', 'nav-picker-places', 'nav-picker-close']);
  });

  test('no layout yet (no width): nothing is decided until the window reports its height', async () => {
    mountsAt(0, 0);
    await renderList().view;
    expect(rootChildren()).toEqual(['header', 'nav-picker-places', 'nav-picker-close']);
    await measureRows(NAV_ROW_MIN_PT - 9);
    expect(rootChildren()).toEqual(['nav-picker-scroll', 'nav-picker-close']);
  });
});

test('an iPhone SE in portrait: the short list keeps a scrolling window at least a row tall above the pinned Cancel', () => {
  const l = hudLayout({ width: 375, height: 667, insets: { top: 20, bottom: 0, left: 0, right: 0 }, fontScale: 1, chip: false, units: 'mi' });
  const inner = l.panel.h - 2 * (16 + 1); // HudScreen's panel padding and border
  const window = inner - 12 - PANEL_CAPSULE_PT; // the gap and the pinned Cancel
  expect(window).toBeGreaterThanOrEqual(NAV_ROW_MIN_PT);
});

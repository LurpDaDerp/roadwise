// "Choose your navigation app": the title, the notice and the footer stay put around the rows'
// own scrolling window. Where that window cannot hold one whole row the list is short: only
// Cancel / Close is pinned and everything else scrolls as one list.
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { ScrollView, StyleSheet } from 'react-native';

import { hudLayout } from '@/features/drive/hudLayout';
import { navCopy } from '@/features/navigation/copy';
import { NAV_ROW_MIN_PT, NavAppPicker } from '@/features/navigation/NavAppPicker';
import { PANEL_CAPSULE_PT } from '@/ui/drive/panelLook';

const COLORS = { surface: '#FFFFFF', ink: '#111113', muted: '#555555', edge: '#DDDDDD' };
const APPS = [
  { id: 'apple_maps', label: 'Apple Maps', target: 'maps://' },
  { id: 'waze', label: 'Waze', target: 'waze://' },
] as const;

type Props = Parameters<typeof NavAppPicker>[0];
const picker = (props: Partial<Props> = {}) => (
  <NavAppPicker apps={APPS} mode="first" driveLine colors={COLORS} onChoose={jest.fn()} onClose={jest.fn()} {...props} />
);
const renderPicker = (props: Partial<Props> = {}) => render(picker(props));

/** The root's children in order: a test ID, or what the unnamed ones say. */
const rootChildren = () =>
  screen.getByTestId('nav-picker').children.map((c) => {
    if (typeof c === 'string') return c;
    if (typeof c.props.testID === 'string') return c.props.testID;
    if (within(c).queryByRole('header') !== null) return 'header';
    if (within(c).queryByTestId('nav-picker-notice') !== null) return 'notice';
    return c.children.includes(navCopy.footer) ? 'footer' : 'other';
  });

/** The rows' window reports its height. */
const measureRows = (height: number) =>
  fireEvent(screen.getByTestId('nav-picker-rows'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 320, height } } });

test.each(['first', 'failed', 'gone'] as const)('%s: the title, the notice and the footer stay put; only the rows scroll', async (mode) => {
  await renderPicker({ mode, missingLabel: 'Google Maps' });
  expect(rootChildren()).toEqual(['header', ...(mode === 'first' ? [] : ['notice']), 'nav-picker-rows', 'footer', 'nav-picker-close']);
  expect(screen.queryByTestId('nav-picker-scroll')).toBeNull();
  const rows = screen.getByTestId('nav-picker-rows');
  expect(within(rows).getAllByRole('button').map((b) => b.props.testID)).toEqual(['nav-picker-row-apple_maps', 'nav-picker-row-waze']);
  expect(within(rows).queryByRole('header')).toBeNull();
  expect(within(rows).queryByText(navCopy.footer)).toBeNull();
  expect(within(rows).queryByTestId('nav-picker-notice')).toBeNull();
  // 12 pt between the parts, 8 pt between the rows; the window gives way first when the panel is short
  expect(StyleSheet.flatten(screen.getByTestId('nav-picker').props.style)).toMatchObject({ gap: 12, flexShrink: 1 });
  expect(StyleSheet.flatten(rows.props.style)).toMatchObject({ flexGrow: 0, flexShrink: 1 });
  expect(StyleSheet.flatten(rows.props.contentContainerStyle)).toEqual({ gap: 8 });
});

test('a rows window a whole row tall or more keeps that layout', async () => {
  await renderPicker();
  await measureRows(NAV_ROW_MIN_PT * 2 + 8);
  await measureRows(NAV_ROW_MIN_PT);
  expect(screen.queryByTestId('nav-picker-scroll')).toBeNull();
  expect(rootChildren()).toEqual(['header', 'nav-picker-rows', 'footer', 'nav-picker-close']);
});

test.each(['first', 'failed', 'gone'] as const)('%s: a rows window under one row turns the list short: only the close capsule is pinned', async (mode) => {
  await renderPicker({ mode, missingLabel: 'Google Maps' });
  await measureRows(NAV_ROW_MIN_PT - 9);
  expect(rootChildren()).toEqual(['nav-picker-scroll', 'nav-picker-close']);
  const scroll = screen.getByTestId('nav-picker-scroll');
  expect(within(scroll).getByRole('header')).toHaveTextContent(navCopy.pickerTitle);
  expect(within(scroll).getByText(navCopy.driveLine)).toBeOnTheScreen();
  expect(within(scroll).getByTestId('nav-picker-row-apple_maps')).toBeOnTheScreen();
  expect(within(scroll).getByTestId('nav-picker-row-waze')).toBeOnTheScreen();
  expect(within(scroll).getByText(navCopy.footer)).toBeOnTheScreen();
  if (mode !== 'first') expect(within(scroll).getByTestId('nav-picker-notice')).toBeOnTheScreen();
  expect(StyleSheet.flatten(scroll.props.style)).toMatchObject({ flexGrow: 0, flexShrink: 1 });
  expect(StyleSheet.flatten(scroll.props.contentContainerStyle)).toEqual({ gap: 12 });
  expect(StyleSheet.flatten(screen.getByTestId('nav-picker-rows').props.style)).toEqual({ gap: 8 });
});

test('a short list stays short for as long as it is on screen; a new one starts over', async () => {
  const view = await renderPicker();
  await measureRows(0);
  expect(rootChildren()).toEqual(['nav-picker-scroll', 'nav-picker-close']);
  // a later, roomier measure of anything in it changes nothing, nor does a new set of apps
  await fireEvent(screen.getByTestId('nav-picker-scroll'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 400 } } });
  await fireEvent(screen.getByTestId('nav-picker-rows'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 400 } } });
  expect(rootChildren()).toEqual(['nav-picker-scroll', 'nav-picker-close']);
  await view.rerender(picker({ apps: [APPS[0]], mode: 'change', selected: 'apple_maps' }));
  expect(rootChildren()).toEqual(['nav-picker-scroll', 'nav-picker-close']);
  expect(screen.queryByTestId('nav-picker-row-waze')).toBeNull();
  await view.unmount();
  await renderPicker();
  expect(rootChildren()).toEqual(['header', 'nav-picker-rows', 'footer', 'nav-picker-close']);
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
    await renderPicker({ mode: 'failed', missingLabel: 'Google Maps' });
    expect(rootChildren()).toEqual(['nav-picker-scroll', 'nav-picker-close']);
    const scroll = screen.getByTestId('nav-picker-scroll');
    expect(within(scroll).getByRole('header')).toHaveTextContent(navCopy.pickerTitle);
    expect(within(scroll).getByTestId('nav-picker-notice')).toBeOnTheScreen();
    expect(within(scroll).getByTestId('nav-picker-row-apple_maps')).toBeOnTheScreen();
    expect(within(scroll).getByText(navCopy.footer)).toBeOnTheScreen();
  });

  test('a whole row or more: the title, the notice and the footer stay put', async () => {
    mountsAt(320, NAV_ROW_MIN_PT);
    await renderPicker();
    expect(rootChildren()).toEqual(['header', 'nav-picker-rows', 'footer', 'nav-picker-close']);
  });

  test('no layout yet (no width): nothing is decided until the window reports its height', async () => {
    mountsAt(0, 0);
    await renderPicker();
    expect(rootChildren()).toEqual(['header', 'nav-picker-rows', 'footer', 'nav-picker-close']);
    await measureRows(NAV_ROW_MIN_PT - 9);
    expect(rootChildren()).toEqual(['nav-picker-scroll', 'nav-picker-close']);
  });
});

test('with no app to list: the title, the empty line and the footer above Close, still unless they overflow', async () => {
  await renderPicker({ apps: [] });
  expect(rootChildren()).toEqual(['nav-picker-scroll', 'nav-picker-close']);
  const scroll = screen.getByTestId('nav-picker-scroll');
  expect(scroll).toHaveProp('alwaysBounceVertical', false);
  expect(within(scroll).getByRole('header')).toHaveTextContent(navCopy.pickerTitle);
  expect(within(scroll).getByTestId('nav-picker-empty')).toHaveTextContent(navCopy.empty);
  expect(within(scroll).getByText(navCopy.footer)).toBeOnTheScreen();
  expect(screen.queryByTestId('nav-picker-rows')).toBeNull();
  expect(within(screen.getByTestId('nav-picker-close')).getByText(navCopy.close)).toBeOnTheScreen();
  expect(StyleSheet.flatten(scroll.props.contentContainerStyle)).toEqual({ gap: 12 });
});

test('on the driving screen the drive line sits under the title, with a gone / failed notice under it', async () => {
  const view = await renderPicker();
  expect(screen.getByText(navCopy.driveLine)).toBeOnTheScreen();
  await view.rerender(picker({ mode: 'failed', missingLabel: 'Waze' }));
  expect(screen.getByTestId('nav-picker-notice')).toHaveTextContent("Waze didn't open.");
  expect(screen.getByText(navCopy.driveLine)).toBeOnTheScreen();
  await view.rerender(picker({ mode: 'gone', missingLabel: 'Waze' }));
  expect(screen.getByTestId('nav-picker-notice')).toHaveTextContent("Waze isn't on this phone anymore.");
  expect(screen.getByText(navCopy.driveLine)).toBeOnTheScreen();
});

test('an iPhone SE in portrait: the short list keeps a scrolling window at least a row tall above the pinned Cancel', () => {
  const l = hudLayout({ width: 375, height: 667, insets: { top: 20, bottom: 0, left: 0, right: 0 }, fontScale: 1, chip: false, units: 'mi' });
  const inner = l.panel.h - 2 * (16 + 1); // HudScreen's panel padding and border
  const window = inner - 12 - PANEL_CAPSULE_PT; // the gap and the pinned Cancel
  expect(window).toBeGreaterThanOrEqual(NAV_ROW_MIN_PT);
});

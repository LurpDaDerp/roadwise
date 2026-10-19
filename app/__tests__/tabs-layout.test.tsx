/**
 * The signed-in tab shell: the four tabs in order with their titles and icons, and the sky behind
 * them (its weather layer still while a drive records, its status bar following the sky whenever
 * the tabs are in front). The navigator and the sky are stand-ins that record their props.
 */
import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { ThemeProvider } from '@/ui';

import TabsLayout from '../(tabs)/_layout';

type TabOptions = { title: string; tabBarIcon: (p: { color: string; size: number; focused: boolean }) => { props: { name: string } } };

const mockTabs: { screens: { name: string; options: TabOptions }[] } = { screens: [] };
const mockNav = { focused: true };
const mockSky: { props: { active: boolean; front?: boolean }[] } = { props: [] };
const mockDrive = { status: 'idle' };

jest.mock('expo-router', () => {
  const Tabs = ({ children }: { children?: ReactNode }) => children;
  Tabs.Screen = function Screen({ name, options }: { name: string; options: TabOptions }) {
    mockTabs.screens.push({ name, options });
    return null;
  };
  return { Tabs, useIsFocused: () => mockNav.focused };
});
jest.mock('@/drive/useDrive', () => ({
  useDrive: (pick: (d: { status: string }) => unknown) => pick(mockDrive),
}));
jest.mock('@/ui', () => ({
  ...jest.requireActual('@/ui'),
  SkyBackdrop: (p: { active: boolean; front?: boolean }) => {
    mockSky.props.push(p);
    return null;
  },
}));

const draw = () =>
  render(
    <ThemeProvider scheme="light" reduceMotion>
      <TabsLayout />
    </ThemeProvider>
  );

beforeEach(() => {
  mockTabs.screens = [];
  mockSky.props = [];
  mockNav.focused = true;
  mockDrive.status = 'idle';
});

test('the tabs are Home, Analytics, Leaderboards and Profile, in that order', async () => {
  await draw();
  const icon = (o: TabOptions, focused: boolean) => o.tabBarIcon({ color: '#000', size: 24, focused }).props.name;
  expect(mockTabs.screens.map((s) => [s.name, s.options.title, icon(s.options, false), icon(s.options, true)])).toEqual([
    ['home', 'Home', 'home-outline', 'home'],
    ['analytics', 'Analytics', 'analytics-outline', 'analytics'],
    ['leagues', 'Leaderboards', 'trophy-outline', 'trophy'],
    ['profile', 'Profile', 'person-circle-outline', 'person-circle'],
  ]);
});

test('the sky moves only while the tabs are in front and no drive records', async () => {
  await draw();
  expect(mockSky.props.at(-1)).toEqual({ active: true, front: true });
});

test('while a drive records, the sky holds still but the status bar still follows it', async () => {
  mockDrive.status = 'recording';
  await draw();
  expect(mockSky.props.at(-1)).toEqual({ active: false, front: true });
});

test('behind another screen, the sky neither moves nor sets the status bar', async () => {
  mockNav.focused = false;
  await draw();
  expect(mockSky.props.at(-1)).toEqual({ active: false, front: false });
});

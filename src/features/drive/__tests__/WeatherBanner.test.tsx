// The dangerous-weather banner on the driving screen: its one line never scales itself (a fixed line on a
// frame a hair short collapsed such text to 4 pt on iOS) and sit on whole points in the band.
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { DANGER_ORDER, type DangerAlert } from '@/features/weather/danger';
import { weatherTitle } from '@/features/weather/copy';
import { HUD } from '@/ui/drive';

import { HUD_WEATHER_PT } from '../hudLayout';
import { WeatherBanner, weatherBannerPt } from '../WeatherBanner';

const alert: DangerAlert = { kind: 'freezing_rain', gustMph: null, visibilityM: null };
const flatStyle = (el: { props: { style?: unknown } }) => StyleSheet.flatten(el.props.style as never) as Record<'lineHeight' | 'paddingVertical', number>;

test.each([false, true])('no self-scaling text (adjustsFontSizeToFit, minimumFontScale) for any alert; the title alone, one line (compact %s)', async (compact) => {
  for (const kind of DANGER_ORDER) {
    const a = { ...alert, kind };
    const r = await render(<WeatherBanner alert={a} units="mi" palette={HUD.day} compact={compact} onDismiss={() => {}} />);
    const el = screen.getByText(weatherTitle(a));
    expect(el.props.adjustsFontSizeToFit).toBeUndefined();
    expect(el.props.minimumFontScale).toBeUndefined();
    expect(el.props.allowFontScaling).toBe(false);
    expect(el.props.numberOfLines).toBe(1);
    expect(screen.getByTestId('hud-weather-title')).toHaveTextContent(weatherTitle(a), { exact: true });
    expect(screen.getByTestId('hud-weather')).not.toHaveTextContent(/sooner|beams|brakes|wheel|extra room|take it|stay off/i);
    await r.unmount();
  }
});

test('one line in a 40 pt card in either size, whose top lands on whole points in the 56 pt band, the 48 pt slot and the compact 40 pt band', async () => {
  for (const compact of [false, true]) {
    const r = await render(<WeatherBanner alert={alert} units="mi" palette={HUD.day} compact={compact} onDismiss={() => {}} />);
    const line = flatStyle(screen.getByText('Freezing rain')).lineHeight;
    expect(Number.isInteger((36 - line) / 2)).toBe(true);
    expect(weatherBannerPt(compact)).toBe(40);
    await r.unmount();
  }
  for (const room of [56, HUD_WEATHER_PT, 40]) expect(Number.isInteger((room - weatherBannerPt(false)) / 2)).toBe(true);
  expect(weatherBannerPt(false)).toBeLessThanOrEqual(HUD_WEATHER_PT);
});

test('only as wide as its words, centred in its slot', async () => {
  await render(<WeatherBanner alert={alert} units="mi" palette={HUD.day} compact={false} onDismiss={() => {}} />);
  expect(screen.getByTestId('hud-weather')).toHaveStyle({ alignSelf: 'center' });
});

describe('while the road state moves the warning lines', () => {
  const fog: DangerAlert = { kind: 'dense_fog', gustMph: null, visibilityM: 150 };

  test('with no alert: the road\'s title alone, and which warnings come sooner spoken', async () => {
    await render(<WeatherBanner alert={null} road={{ road: { g: 'wet' }, title: 'Wet roads' }} units="mi" palette={HUD.day} compact={false} onDismiss={() => {}} />);
    expect(screen.getByTestId('hud-weather-title')).toHaveTextContent('Wet roads', { exact: true });
    expect(screen.getByTestId('hud-weather')).not.toHaveTextContent(/sooner|beams|brakes|wheel|extra room|take it|stay off/i);
    expect(screen.getByRole('alert')).toHaveProp('accessibilityLabel', 'Wet roads. Speeding warnings come at a lower speed, and hard braking, start and turn warnings at a lighter touch.');
  });

  test('with an alert: the alert\'s title alone; visibility alone moves only the speed', async () => {
    const onDismiss = jest.fn();
    await render(<WeatherBanner alert={fog} road={{ road: { cap: 55 }, title: 'Low visibility' }} units="mi" palette={HUD.day} compact onDismiss={onDismiss} />);
    expect(screen.getByTestId('hud-weather-title')).toHaveTextContent('Dense fog', { exact: true });
    expect(screen.getByTestId('hud-weather')).not.toHaveTextContent(/sooner|beams|brakes|wheel|extra room|take it|stay off/i);
    expect(screen.getByRole('alert')).toHaveProp('accessibilityLabel', 'Dense fog. Speeding warnings come at a lower speed.');
    await fireEvent.press(screen.getByTestId('hud-weather-close'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('with no road state the card is the alert\'s alone, as it was given', async () => {
    await render(<WeatherBanner alert={fog} road={null} units="mi" palette={HUD.day} compact={false} onDismiss={() => {}} />);
    expect(screen.getByTestId('hud-weather-title')).toHaveTextContent('Dense fog', { exact: true });
    expect(screen.getByTestId('hud-weather')).not.toHaveTextContent(/sooner|beams|brakes|wheel|extra room|take it|stay off/i);
    expect(screen.getByRole('alert')).toHaveProp('accessibilityLabel', 'Weather alert. Dense fog. Visibility 500 ft. Slow down and use your low beams.');
  });
});

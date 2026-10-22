// The dangerous-weather banner on the driving screen: its two lines never scale themselves (a fixed line on a
// frame a hair short collapsed such text to 4 pt on iOS) and sit on whole points in the band.
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { DANGER_ORDER, type DangerAlert } from '@/features/weather/danger';
import { weatherTitle } from '@/features/weather/copy';
import { HUD } from '@/ui/drive';

import { WeatherBanner, weatherBannerPt } from '../WeatherBanner';

const alert: DangerAlert = { kind: 'freezing_rain', gustMph: null, visibilityM: null };
const flatStyle = (el: { props: { style?: unknown } }) => StyleSheet.flatten(el.props.style as never) as Record<'lineHeight' | 'paddingVertical', number>;

test.each([false, true])('no self-scaling text (adjustsFontSizeToFit, minimumFontScale) for any alert; one line each (compact %s)', async (compact) => {
  for (const kind of DANGER_ORDER) {
    const a = { ...alert, kind };
    const r = await render(<WeatherBanner alert={a} units="mi" palette={HUD.day} compact={compact} onDismiss={() => {}} />);
    for (const el of [screen.getByText(weatherTitle(a)), screen.getByTestId('hud-weather-action')]) {
      expect(el.props.adjustsFontSizeToFit).toBeUndefined();
      expect(el.props.minimumFontScale).toBeUndefined();
      expect(el.props.allowFontScaling).toBe(false);
      expect(el.props.numberOfLines).toBe(1);
    }
    await r.unmount();
  }
});

test('the compact lines add up to the 36 pt box the bar leaves (40 less its outlines), so both tops are whole points; the band still holds it', async () => {
  await render(<WeatherBanner alert={alert} units="mi" palette={HUD.day} compact onDismiss={() => {}} />);
  expect(flatStyle(screen.getByText('Freezing rain')).lineHeight + flatStyle(screen.getByTestId('hud-weather-action')).lineHeight).toBe(36);
  expect(weatherBannerPt(true)).toBe(40);
});

test('the full lines and padding make a bar whose top in the 56 pt band is a whole number of points', () => {
  expect(Number.isInteger((56 - weatherBannerPt(false)) / 2)).toBe(true);
});

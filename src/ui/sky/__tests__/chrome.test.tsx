import { render } from '@testing-library/react-native';
import { Appearance } from 'react-native';

import { SkyChrome } from '@/ui/sky/SkyChrome';
import { ThemeProvider } from '@/ui/theme';

afterEach(() => jest.restoreAllMocks());

test("the app's own scheme overrides the phone's for the parts RoadWise does not draw", async () => {
  const spy = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => {});
  const view = await render(
    <ThemeProvider scheme="dark">
      <SkyChrome />
    </ThemeProvider>
  );
  expect(spy).toHaveBeenLastCalledWith('dark');
  await view.rerender(
    <ThemeProvider scheme="light">
      <SkyChrome />
    </ThemeProvider>
  );
  expect(spy).toHaveBeenLastCalledWith('light');
});

test("under System the override is handed back to the phone's own setting", async () => {
  const spy = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => {});
  const view = await render(
    <ThemeProvider scheme="dark">
      <SkyChrome />
    </ThemeProvider>
  );
  await view.rerender(
    <ThemeProvider>
      <SkyChrome followSystem />
    </ThemeProvider>
  );
  expect(spy).toHaveBeenLastCalledWith('unspecified');
});

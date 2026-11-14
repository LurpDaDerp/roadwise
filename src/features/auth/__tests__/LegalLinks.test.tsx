import { fireEvent, render, screen } from '@testing-library/react-native';
import type { Href } from 'expo-router';

import { LEGAL_HREFS, LegalLinks } from '@/features/auth/LegalLinks';
import { ThemeProvider } from '@/ui/theme';

const mount = async (navigate = jest.fn((_href: Href) => {})) => {
  await render(
    <ThemeProvider>
      <LegalLinks navigate={navigate} />
    </ThemeProvider>
  );
  return navigate;
};

test('a link to each document, opening its in-app reading screen', async () => {
  const navigate = await mount();
  expect(screen.getAllByRole('link')).toHaveLength(2);
  await fireEvent.press(screen.getByRole('link', { name: 'Terms' }));
  await fireEvent.press(screen.getByRole('link', { name: 'Privacy Policy' }));
  expect(navigate.mock.calls).toEqual([['/legal/terms'], ['/legal/privacy']]);
});

test('the hrefs are the legal route, one per document', () => {
  expect(LEGAL_HREFS).toEqual({ terms: '/legal/terms', privacy: '/legal/privacy' });
});

test('says what each link opens', async () => {
  await mount();
  for (const link of screen.getAllByRole('link')) {
    expect(link.props.accessibilityHint).toBe('Opens the full text');
  }
});

test('each link is a 44 pt target', async () => {
  await mount();
  for (const link of screen.getAllByRole('link')) {
    const style = [link.props.style].flat(Infinity).reduce((a, b) => ({ ...a, ...b }), {});
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  }
});

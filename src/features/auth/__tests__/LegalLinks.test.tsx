import { fireEvent, render, screen } from '@testing-library/react-native';

import type { LegalState } from '@/features/auth/legal';
import { LegalLinks } from '@/features/auth/LegalLinks';
import { ThemeProvider } from '@/ui/theme';

const TOS = { version: '2026-09-21', url: 'https://roadwise.app/terms' };
const PRIVACY = { version: '2026-09-21', url: 'https://roadwise.app/privacy' };

const mount = async (legal: LegalState, open = jest.fn(async (_url: string) => {})) => {
  await render(
    <ThemeProvider>
      <LegalLinks legal={legal} open={open} />
    </ThemeProvider>
  );
  return open;
};

test('both published: a link to each, opening its own URL', async () => {
  const open = await mount({ published: true, tos: TOS, privacy: PRIVACY });
  const links = screen.getAllByRole('link');
  expect(links).toHaveLength(2);
  await fireEvent.press(screen.getByRole('link', { name: 'Terms' }));
  await fireEvent.press(screen.getByRole('link', { name: 'Privacy Policy' }));
  expect(open.mock.calls).toEqual([[TOS.url], [PRIVACY.url]]);
});

test('says each link leaves the app', async () => {
  await mount({ published: true, tos: TOS, privacy: PRIVACY });
  for (const link of screen.getAllByRole('link')) {
    expect(link.props.accessibilityHint).toBe('Opens in your browser');
  }
});

test('only the document that exists is linked', async () => {
  await mount({ published: false, tos: null, privacy: PRIVACY });
  expect(screen.getAllByRole('link')).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'Privacy Policy' })).toBeOnTheScreen();
  expect(screen.queryByText('Terms')).toBeNull();
});

test('nothing published renders nothing at all', async () => {
  await mount({ published: false, tos: null, privacy: null });
  expect(screen.toJSON()).toBeNull();
});

test('each link is a 44 pt target', async () => {
  await mount({ published: true, tos: TOS, privacy: PRIVACY });
  for (const link of screen.getAllByRole('link')) {
    const style = [link.props.style].flat(Infinity).reduce((a, b) => ({ ...a, ...b }), {});
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  }
});

test('a browser that fails to open is not an unhandled rejection', async () => {
  const open = jest.fn(async (_url: string): Promise<void> => {
    throw new Error('no browser');
  });
  await mount({ published: true, tos: TOS, privacy: PRIVACY }, open);
  await fireEvent.press(screen.getByRole('link', { name: 'Terms' }));
  expect(open).toHaveBeenCalledTimes(1);
});

import { render, screen } from '@testing-library/react-native';
import type { TextStyle } from 'react-native';

import { Text } from '@/ui/primitives/Text';
import { ThemeProvider } from '@/ui/theme';

test('renders a variant with its font size', async () => {
  await render(
    <ThemeProvider>
      <Text variant="title1">Hello</Text>
    </ThemeProvider>
  );
  const el = screen.getByText('Hello');
  const flat: TextStyle = Object.assign({}, ...[el.props.style].flat());
  expect(flat.fontSize).toBeGreaterThanOrEqual(28);
});

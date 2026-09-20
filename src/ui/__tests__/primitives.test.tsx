import { render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { Banner } from '@/ui/primitives/Banner';
import { Card } from '@/ui/primitives/Card';
import { Skeleton } from '@/ui/primitives/Skeleton';
import { Text } from '@/ui/primitives/Text';
import { ThemeProvider } from '@/ui/theme';

const wrap = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

test('a licence card face still renders its children over the laminate sheen', async () => {
  await wrap(
    <Card variant="license">
      <Text>CLASS 1</Text>
    </Card>
  );
  expect(screen.getByText('CLASS 1')).toBeOnTheScreen();
});

test('a banner exposes its message as text, not colour alone', async () => {
  await wrap(<Banner tone="warning" message="Location permission is off" />);
  expect(screen.getByText('Location permission is off')).toBeOnTheScreen();
});

test('a skeleton field mounts its pulse and stays out of the accessibility tree', async () => {
  await wrap(<Skeleton width={120} height={16} testID="field" />);
  expect(screen.queryByTestId('field')).toBeNull();
  expect(screen.getByTestId('field', { includeHiddenElements: true })).toBeOnTheScreen();
});

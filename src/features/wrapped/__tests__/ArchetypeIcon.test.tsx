import { render, screen } from '@testing-library/react-native';

import { ArchetypeIcon } from '../ArchetypeIcon';
import { PATTERN_IDS } from '../archetypes';

const H = { includeHiddenElements: true } as const;

test.each(PATTERN_IDS)('%s draws, decorative, with or without its disc', async (pattern) => {
  await render(<ArchetypeIcon pattern={pattern} size={48} testID="icon" />);
  const icon = screen.getByTestId('icon', H);
  expect(icon.props.accessibilityElementsHidden).toBe(true);
  expect(screen.queryByTestId('icon-disc', H)).toBeNull();
  await render(<ArchetypeIcon pattern={pattern} size={48} disc="#04684A" testID="icon" />);
  expect(screen.getByTestId('icon-disc', H)).toBeTruthy();
});

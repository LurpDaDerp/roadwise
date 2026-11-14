import { fireEvent, render, screen } from '@testing-library/react-native';

import { LEGAL_DOCUMENTS } from '@/features/legal/documents';
import { isLegalDoc, LegalDocumentView } from '@/features/legal/LegalDocumentScreen';
import { ThemeProvider } from '@/ui/theme';

const mount = async (doc: 'terms' | 'privacy', open = jest.fn(async (_url: string) => {})) => {
  const onBack = jest.fn();
  await render(
    <ThemeProvider>
      <LegalDocumentView doc={doc} onBack={onBack} open={open} />
    </ThemeProvider>
  );
  return { open, onBack };
};

test.each(['terms', 'privacy'] as const)('%s: the title is the header and the sections follow', async (doc) => {
  await mount(doc);
  const headers = screen.getAllByRole('header');
  expect(headers[0]).toHaveTextContent(LEGAL_DOCUMENTS[doc].title);
  expect(headers.length).toBeGreaterThan(5);
  // The document's own # title is not drawn a second time.
  expect(screen.getAllByText(LEGAL_DOCUMENTS[doc].title)).toHaveLength(1);
});

test('the contact email opens the mail app, and Back goes back', async () => {
  const { open, onBack } = await mount('privacy');
  await fireEvent.press(screen.getAllByRole('link', { name: 'roadwise.contact@gmail.com' })[0]!);
  expect(open).toHaveBeenCalledWith('mailto:roadwise.contact@gmail.com');
  await fireEvent.press(screen.getByLabelText('Back'));
  expect(onBack).toHaveBeenCalledTimes(1);
});

test('only the two documents are routes', () => {
  expect(isLegalDoc('terms')).toBe(true);
  expect(isLegalDoc('privacy')).toBe(true);
  expect(isLegalDoc('toString')).toBe(false);
  expect(isLegalDoc(undefined)).toBe(false);
});

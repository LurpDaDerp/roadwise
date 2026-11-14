import * as WebBrowser from 'expo-web-browser';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Linking, ScrollView, View } from 'react-native';

import { BackHeader } from '@/features/drives/BackHeader';
import { Screen, Text, useTheme } from '@/ui';

import { LEGAL_DOCUMENTS, type LegalDocKey } from './documents';
import { parseMarkdown, type Block, type Span } from './markdown';

/** Where a link in a document goes: a web page in the in-app browser, an email in the mail app. */
export function openLegalLink(url: string): Promise<unknown> {
  if (/^mailto:/i.test(url)) return Linking.openURL(url);
  if (/^https?:\/\//i.test(url)) return WebBrowser.openBrowserAsync(url);
  return Promise.resolve();
}

export const isLegalDoc = (v: unknown): v is LegalDocKey => typeof v === 'string' && Object.prototype.hasOwnProperty.call(LEGAL_DOCUMENTS, v);

function Spans({ spans, open }: { spans: readonly Span[]; open: (url: string) => Promise<unknown> }) {
  return (
    <>
      {spans.map((s, i) => {
        const weight = s.bold ? ({ fontWeight: '700' } as const) : null;
        if (s.kind === 'text') {
          return (
            <Text key={i} style={weight}>
              {s.text}
            </Text>
          );
        }
        return (
          <Text
            key={i}
            tone="accent"
            accessibilityRole="link"
            style={[{ textDecorationLine: 'underline' }, weight]}
            onPress={() => {
              // No mail app or browser to hand is not a crash; the link simply does nothing.
              open(s.url).catch(() => {});
            }}
          >
            {s.text}
          </Text>
        );
      })}
    </>
  );
}

function BlockView({ block, open }: { block: Block; open: (url: string) => Promise<unknown> }) {
  const th = useTheme();
  switch (block.kind) {
    case 'heading':
      // The title is the screen's header; the document's own sections are headings below it.
      return (
        <Text variant={block.level === 2 ? 'title3' : 'headline'} accessibilityRole="header" style={{ marginTop: block.level === 2 ? th.space.lg : th.space.sm }}>
          {block.text}
        </Text>
      );
    case 'paragraph':
      return (
        <Text variant="body">
          <Spans spans={block.spans} open={open} />
        </Text>
      );
    case 'item':
      return (
        <View style={{ flexDirection: 'row', gap: th.space.sm, paddingLeft: block.depth === 1 ? th.space.lg : 0 }}>
          <Text variant="body" tone="subtle" importantForAccessibility="no" accessibilityElementsHidden>
            {block.depth === 1 ? '◦' : '•'}
          </Text>
          <Text variant="body" style={{ flex: 1 }}>
            <Spans spans={block.spans} open={open} />
          </Text>
        </View>
      );
    case 'rule':
      return <View style={{ height: 1, backgroundColor: th.colors.border, marginVertical: th.space.sm }} />;
  }
}

/**
 * One legal document, read in the app: the Terms of Service or the Privacy Policy, bundled with this
 * build (`documents.ts`, written by `npm run legal:sync`), so it opens offline and before sign-in.
 */
export function LegalDocumentView({
  doc,
  onBack,
  open = openLegalLink,
}: {
  doc: LegalDocKey;
  onBack: () => void;
  /** Injectable for tests; defaults to the in-app browser and the mail app. */
  open?: (url: string) => Promise<unknown>;
}) {
  const th = useTheme();
  const { title, source } = LEGAL_DOCUMENTS[doc];
  // The document's own `#` title is the header; everything after it is the body.
  const blocks = useMemo(() => parseMarkdown(source).filter((b) => !(b.kind === 'heading' && b.level === 1)), [source]);
  return (
    <ScrollView contentContainerStyle={{ padding: th.space.lg, gap: th.space.md }} testID={`legal-${doc}`}>
      <BackHeader title={title} onBack={onBack} />
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} open={open} />
      ))}
    </ScrollView>
  );
}

export function LegalDocumentScreen({ doc }: { doc: LegalDocKey }) {
  const router = useRouter();
  return (
    <Screen padded={false}>
      {/* Reached from sign-in and from Settings: Back returns there, or to the launch router. */}
      <LegalDocumentView doc={doc} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
    </Screen>
  );
}

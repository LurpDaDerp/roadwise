import { DISCLAIMER_VERSION, SAFETY_DISCLAIMER, legalState, type LegalConfig } from '@/features/auth/legal';

const versions = { tos_version: '2026-09-01', privacy_version: '2026-09-02' };
const TERMS = 'https://roadwise.example/terms';
const PRIVACY = 'https://roadwise.example/privacy';

test('the disclaimer is the product spec A3 sentence, word for word, at its dated version', () => {
  expect(SAFETY_DISCLAIMER).toBe('RoadWise is a coaching aid and may miss or misreport events');
  expect(DISCLAIMER_VERSION).toBe('2026-09-21');
});

const cases: [string, LegalConfig, ReturnType<typeof legalState>][] = [
  ['nothing configured', {}, { published: false, tos: null, privacy: null }],
  ['versions but no URLs', { onboarding: versions }, { published: false, tos: null, privacy: null }],
  [
    'only the Terms URL',
    { onboarding: versions, legal_urls: { terms: TERMS } },
    { published: false, tos: { version: '2026-09-01', url: TERMS }, privacy: null },
  ],
  [
    'only the Privacy URL',
    { onboarding: versions, legal_urls: { privacy: PRIVACY } },
    { published: false, tos: null, privacy: { version: '2026-09-02', url: PRIVACY } },
  ],
  [
    'both URLs',
    { onboarding: versions, legal_urls: { terms: TERMS, privacy: PRIVACY } },
    {
      published: true,
      tos: { version: '2026-09-01', url: TERMS },
      privacy: { version: '2026-09-02', url: PRIVACY },
    },
  ],
  // A URL nobody can record a version against is not something anyone can consent to.
  [
    'both URLs but no versions',
    { legal_urls: { terms: TERMS, privacy: PRIVACY } },
    { published: false, tos: null, privacy: null },
  ],
  // Empty or blank URLs (an unpublished seed), and anything that is not a web address, are not published.
  [
    'empty strings',
    { onboarding: versions, legal_urls: { terms: '', privacy: '  ' } },
    { published: false, tos: null, privacy: null },
  ],
  [
    'not a web address',
    { onboarding: versions, legal_urls: { terms: 'terms.html', privacy: 'javascript:alert(1)' } },
    { published: false, tos: null, privacy: null },
  ],
  [
    'blank versions',
    { onboarding: { tos_version: ' ', privacy_version: '' }, legal_urls: { terms: TERMS, privacy: PRIVACY } },
    { published: false, tos: null, privacy: null },
  ],
];

test.each(cases)('legalState: %s', (_name, config, expected) => {
  expect(legalState(config)).toEqual(expected);
});

test('legalState tolerates values of the wrong type without throwing', () => {
  const junk = { onboarding: { tos_version: 3, privacy_version: null }, legal_urls: { terms: {}, privacy: 7 } };
  expect(legalState(junk as unknown as LegalConfig)).toEqual({ published: false, tos: null, privacy: null });
  expect(legalState(null as unknown as LegalConfig)).toEqual({ published: false, tos: null, privacy: null });
});

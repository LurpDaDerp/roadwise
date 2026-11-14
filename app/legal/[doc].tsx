import { Redirect, useLocalSearchParams } from 'expo-router';

import { isLegalDoc, LegalDocumentScreen } from '@/features/legal/LegalDocumentScreen';

/**
 * The Terms of Service (`/legal/terms`) and the Privacy Policy (`/legal/privacy`), readable before
 * sign-in and from Settings: the gate leaves this route alone for every session state. Any other
 * name goes back to the launch router.
 */
export default function LegalRoute() {
  const { doc } = useLocalSearchParams<{ doc: string }>();
  if (!isLegalDoc(doc)) return <Redirect href="/" />;
  return <LegalDocumentScreen doc={doc} />;
}

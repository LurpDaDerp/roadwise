import { InboxScreen } from '@/features/inbox';

/**
 * `/inbox` — B3, the inbox: every notification mirrored (§11.1 rule 4). The notification host
 * opens it for any tap whose url is not on its allowlist, and Home's bell opens it.
 */
export default function InboxRoute() {
  return <InboxScreen />;
}

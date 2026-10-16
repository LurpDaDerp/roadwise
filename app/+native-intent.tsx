import { formatCode, linkDomain, parseDashpalLink } from '@/dashcam/label';
import { dashpalSecrets, type DashpalSecrets } from '@/dashcam/secure';

/**
 * Every link the OS hands the app passes through here first. Only the app's own link shapes go
 * through — a friend link (`add/`), a clan invite (`clan/`), a drive summary (`drives/`), the
 * magic-link landing (`auth/callback`) and a DashPal's pairing-code link; anything else,
 * `roadwise://drive` above all, opens Home. Nothing a link can open starts a drive (plan §1.4).
 *
 * A DashPal link (the label's `https://<LINK_DOMAIN>/dashpal#d=…&k=…` App Link / Universal Link, or
 * `roadwise://dashpal`) never takes its code into the router: the code goes to SecureStore
 * (`dashpal.pendingCode`, at most 12 h) and the route is `/dashpal?d=<dashcam id>`, which opens the
 * Pair screen (or waits for sign-in, onboarding or the end of a drive). A code that cannot be kept is
 * dropped: the driver scans it again. A link with a bad `d` or `k` opens the code step.
 */
const ALLOWED = /^(add\/[^/?#]+|clan\/[^/?#]+|drives(\/[^/?#]+)?|auth\/callback)([?#].*)?$/;
/** The shapes of a DashPal link, valid or not (`dashpal`, `dashpal/`, then a query or fragment). */
const DASHPAL = /^dashpal\/?([?#].*)?$/;

/** `roadwise://clan/ABC`, `roadwise:///clan/ABC`, `/clan/ABC` → `clan/ABC`. */
function appPath(path: string): string {
  return path.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/+/, '');
}

/** An https link's host and path (`pair.example.com/dashpal#…` → `dashpal#…` when the host is ours). */
function httpsPath(path: string, domain: string): string | null {
  const m = /^https:\/\/([^/?#]+)(.*)$/i.exec(path);
  if (!m) return null;
  return domain.length > 0 && m[1]!.toLowerCase() === domain ? m[2]!.replace(/^\/+/, '') : '';
}

async function dashpalRoute(path: string, domain: string, secrets: DashpalSecrets, now: () => number): Promise<string> {
  const https = /^https:/i.test(path);
  const parts = parseDashpalLink(https ? path : `roadwise://${appPath(path)}`, domain);
  if (parts === 'not_a_code') return '/dashpal';
  if (parts.code) {
    try {
      await secrets.writePendingCode({ at: now(), dashcamId: parts.d, code: formatCode(parts.code.S, parts.code.kind, { dashes: false }) });
    } catch {
      // not kept: the driver scans the code again at the code step
    }
  }
  return parts.d ? `/dashpal?d=${parts.d}` : '/dashpal';
}

export async function redirectSystemPath(
  { path }: { path: string; initial: boolean },
  deps: { domain?: string; secrets?: DashpalSecrets; now?: () => number } = {}
): Promise<string> {
  try {
    // The dev client's own launcher links are not app routes; leave them to it.
    if (path.includes('expo-development-client')) return path;
    const domain = deps.domain ?? linkDomain();
    const fromWeb = httpsPath(path, domain);
    if (fromWeb !== null) {
      // An https link: only our link domain's DashPal path is ours.
      return DASHPAL.test(fromWeb) ? await dashpalRoute(path, domain, deps.secrets ?? dashpalSecrets, deps.now ?? Date.now) : '/';
    }
    const p = appPath(path);
    if (DASHPAL.test(p)) return await dashpalRoute(path, domain, deps.secrets ?? dashpalSecrets, deps.now ?? Date.now);
    return ALLOWED.test(p) ? `/${p}` : '/';
  } catch {
    return '/';
  }
}

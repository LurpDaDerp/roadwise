/**
 * Every link the OS hands the app passes through here first. Only the app's own link shapes go
 * through — a friend link (`add/`), a clan invite (`clan/`), a drive summary (`drives/`), the
 * magic-link landing (`auth/callback`) and the DashPal box's QR code (`dashpal`, which opens the
 * setup, or waits until no drive is open); anything else, `roadwise://drive` above all, opens Home.
 * Nothing a link can open starts a drive (plan §1.4).
 */
const ALLOWED = /^(add\/[^/?#]+|clan\/[^/?#]+|drives(\/[^/?#]+)?|auth\/callback|dashpal)([?#].*)?$/;

/** `roadwise://clan/ABC`, `roadwise:///clan/ABC`, `/clan/ABC` → `clan/ABC`. */
function appPath(path: string): string {
  return path.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/+/, '');
}

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    // The dev client's own launcher links are not app routes; leave them to it.
    if (path.includes('expo-development-client')) return path;
    const p = appPath(path);
    return ALLOWED.test(p) ? `/${p}` : '/';
  } catch {
    return '/';
  }
}

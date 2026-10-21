/**
 * Every link the OS hands the app passes through here first. Only the app's own link shapes go
 * through: a friend link (`add/`), a drive summary (`drives/`) and the driving screen
 * (`roadwise://drive`, which the Live Activity and the widget open, and only that exact link);
 * anything else (any `dashpal` path, a `drive` link with parameters) opens Home. Nothing a link can
 * open starts a drive (plan §1.4): the driving screen only shows a drive already recording.
 */
const ALLOWED = /^(add\/[^/?#]+|drives(\/[^/?#]+)?)([?#].*)?$|^drive$/;

/** `roadwise://add/maya`, `roadwise:///add/maya`, `/add/maya` → `add/maya`. */
function appPath(path: string): string {
  return path.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/+/, '');
}

export async function redirectSystemPath({ path }: { path: string; initial: boolean }): Promise<string> {
  try {
    // The dev client's own launcher links are not app routes; leave them to it.
    if (path.includes('expo-development-client')) return path;
    // A web link is never one of the app's own.
    if (/^https?:/i.test(path)) return '/';
    const p = appPath(path);
    return ALLOWED.test(p) ? `/${p}` : '/';
  } catch {
    return '/';
  }
}

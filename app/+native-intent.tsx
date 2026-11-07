import { linkDomain } from '@/lib/linkDomain';

/**
 * Every link the OS hands the app passes through here first. Only the app's own link shapes go
 * through: a friend link (`add/`), a drive summary (`drives/`), the driving screen
 * (`roadwise://drive`, which the Live Activity and the widget open, and only that exact link), a
 * shared monthly Wrapped (`w/<id>`, a trailing slash, query or fragment dropped) and the Wrapped archive or one month of it (`wrapped`,
 * `wrapped/YYYY-MM`); anything else (any `dashpal` path, a `drive` link with parameters) opens
 * Home. A web link opens the app only as a shared Wrapped: `https://<link domain>/w/<id>` on the
 * one configured link domain (`@/lib/linkDomain`; none is set yet, so no web link opens anything).
 * Nothing a link can open starts a drive (plan §1.4): the driving screen only shows a drive
 * already recording.
 */
const ALLOWED = /^(add\/[^/?#]+|drives(\/[^/?#]+)?)([?#].*)?$|^drive$|^wrapped(\/\d{4}-(0[1-9]|1[0-2]))?$/;
/**
 * A shared Wrapped: `w/<id>`, then at most a trailing slash and a query or fragment (apps add
 * tracking parameters to tapped links). The route is built from the id alone, so those are dropped.
 * The same shape as `parseWrappedLink` (`@/features/social/links`).
 */
const SCHEME_WRAPPED = /^w\/([A-Za-z0-9]{12})\/?(?:[?#].*)?$/;
/** A shared Wrapped on the web: https only, the host checked against the link domain apart. */
const WEB_WRAPPED = /^https:\/\/([^/?#]+)\/w\/([A-Za-z0-9]{12})\/?(?:[?#].*)?$/i;

/** `roadwise://add/maya`, `roadwise:///add/maya`, `/add/maya` → `add/maya`. */
function appPath(path: string): string {
  return path.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/+/, '');
}

export async function redirectSystemPath({ path }: { path: string; initial: boolean }): Promise<string> {
  try {
    // The dev client's own launcher links are not app routes; leave them to it.
    if (path.includes('expo-development-client')) return path;
    // A web link is one of the app's own only as a shared Wrapped on the link domain.
    if (/^https?:/i.test(path)) {
      const web = WEB_WRAPPED.exec(path);
      const domain = linkDomain();
      return web && domain !== null && web[1]!.toLowerCase() === domain ? `/w/${web[2]!}` : '/';
    }
    const p = appPath(path);
    const shared = SCHEME_WRAPPED.exec(p);
    if (shared) return `/w/${shared[1]!}`;
    return ALLOWED.test(p) ? `/${p}` : '/';
  } catch {
    return '/';
  }
}

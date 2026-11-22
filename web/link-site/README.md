# getroadwise.app

RoadWise's website, hosted on Vercel (project `getroadwise`), DNS at Cloudflare: the landing page,
Support, Delete your account, the Privacy Policy, the Terms of Service, and the share-link files
for a shared monthly Wrapped (`https://getroadwise.app/w/<id>`).

```
npm run site:build    # builds web/site-dist/ (git-ignored)
npm run site:deploy   # builds, then `vercel deploy --prod` from web/site-dist/
```

The deploy refuses to run unless `web/site-dist/.vercel/project.json` links the folder to the
project `getroadwise`. That link lives in the git-ignored build folder, so on a fresh clone,
another machine or after the folder is deleted, run `vercel link --project getroadwise` in
`web/site-dist/` once (the build keeps `.vercel/`). Without the check, `vercel deploy --yes` in an
unlinked folder would quietly create a new project named after it.

`scripts/build-site.js` assembles it:

- Everything in this folder is copied as it is, except `_pages/`, `site.json`, this README and the
  two association files.
- `_pages/*.html` are page bodies with a comment header (`title`, `description`, and `hero: true`
  or `heading` / `intro`); each becomes `<name>/index.html` in the shared layout (sky header, footer).
  `{{stores}}` becomes the store buttons, or "Coming soon" until there is a store id.
- `/privacy` and `/terms` come from the local legal drafts in `legal/` (git-ignored), through the
  app's own Markdown parser, so the site says what the app says. Run `npm run legal:sync` and
  `npm run site:deploy` together after any legal change.
- `vercel.json` (written by the build): clean URLs, `/w/<id>` answered by `w/index.html`,
  `www.getroadwise.app` redirected to the apex, the association files served as
  `application/json`, and a strict Content-Security-Policy (nothing loads from another host: the
  fonts are self-hosted, `fonts/OFL.txt`).
- `robots.txt` (written by the build) blocks nothing and names `sitemap.xml`. The share page keeps
  itself out of search with its own `noindex` tag, which a crawler can read only if it may fetch
  the page.

## site.json (nothing in it is secret)

| Key | What it turns on |
|---|---|
| `appleTeamId` | The 10-character Apple Developer team ID: writes `/.well-known/apple-app-site-association`, so iOS opens `/w/*` links in RoadWise |
| `appStoreId` | The numeric App Store id: the App Store button and the share page's "Get RoadWise" |
| `playStoreLive` | `true` once the Google Play listing is public: the Google Play button |
| `androidCertSha256` | The Play app signing key's and the upload key's SHA-256 (`AB:CD:...`, 32 pairs): writes `/.well-known/assetlinks.json`, so Android opens `/w/*` links in RoadWise |

An association file is left out until its value exists: one with a placeholder would point the
links at no app. Until then a share link opens the web page, whose "Open in RoadWise" button opens
`roadwise://w/<id>`.

Where the values are: team ID at developer.apple.com › Membership details; App Store id in App
Store Connect › the app › App Information › Apple ID; the Android fingerprints in Play Console ›
Test and release › Setup › App signing (both "App signing key certificate" and "Upload key
certificate"; the upload key also shows in `eas credentials -p android`).

## Checking the links

- iPhone, with a build made after `appleTeamId` was deployed: open `https://getroadwise.app/w/<id>`
  from Notes or Messages; it opens the Wrapped in RoadWise. Apple's CDN can take up to a day to
  pick up a changed association file.
- Android: `adb shell pm get-app-links com.lurp.safedrive` shows the domain as `verified`
  (`adb shell pm verify-app-links --re-verify com.lurp.safedrive` asks again).

## DNS (Cloudflare, DNS only, never proxied)

| Type | Name | Target |
|---|---|---|
| CNAME | `@` | `6a1c84a26decd35d.vercel-dns-017.com` |
| CNAME | `www` | `6a1c84a26decd35d.vercel-dns-017.com` |

`vercel domains verify getroadwise.app` checks them.

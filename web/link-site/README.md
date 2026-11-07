# RoadWise link site

The static files behind RoadWise's share links (a shared monthly Wrapped: `https://<domain>/w/<id>`).
Nothing here is deployed yet. Until it is, the app shares `roadwise://w/<id>` links instead.

- `.well-known/apple-app-site-association`: tells iOS to open `/w/*` links in RoadWise (universal links).
- `w/index.html`: the page for anyone without the app. "Open in RoadWise" opens `roadwise://w/<id>`
  for the same id, and "Get RoadWise" goes to the App Store.

## Deploy

1. Choose the domain (for example `roadwise.app`).
2. In `.well-known/apple-app-site-association`, replace `TEAMID` with the Apple Developer team ID
   (Xcode or developer.apple.com › Membership). In `w/index.html`, replace `APP_STORE_ID` with the
   app's App Store id.
3. Host this folder at the domain's root, over https:
   - Serve `/.well-known/apple-app-site-association` with `Content-Type: application/json`, with no
     redirect (Apple's CDN fetches it directly and rejects redirects) and no `.json` extension.
   - Serve `w/index.html` for every `/w/<id>` path (a rewrite of `/w/*` to `/w/index.html`).
4. Set `ROADWISE_LINK_DOMAIN=<domain>` for EAS builds (an EAS environment variable) and locally.
   `app.config.ts` then adds `applinks:<domain>` to the iOS associated domains and
   `extra.linkDomain`, which the app uses to build and accept `https://<domain>/w/<id>` links.
5. Make a new iOS build: associated domains change the native project, so this can't ship as an
   over-the-air update. Set `EXPO_APPLE_TEAM_ID` too if it isn't already.
6. Check it: on an iPhone with the new build, open `https://<domain>/w/<id>` from Notes or Messages;
   it should open the Wrapped in RoadWise. Apple's CDN can take up to a day to pick up a changed
   association file.

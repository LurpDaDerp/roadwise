# RoadWise link site

The static files behind RoadWise's share links (a shared monthly Wrapped: `https://<domain>/w/<id>`).
Nothing here is deployed yet. Until it is, the app shares `roadwise://w/<id>` links instead.

- `.well-known/apple-app-site-association`: tells iOS to open `/w/*` links in RoadWise (universal links).
- `.well-known/assetlinks.json`: tells Android to open the same `/w/` links in RoadWise (a verified
  App Link). It ships with two placeholders, never a real or made-up fingerprint (step 3).
- `w/index.html`: the page for anyone without the app. "Open in RoadWise" opens `roadwise://w/<id>`
  for the same id, and "Get RoadWise" goes to the App Store. On Android (by user agent) "Get
  RoadWise" goes to Google Play, and "Open in RoadWise" is an `intent://` link to the same
  `roadwise://w/<id>`, with Google Play as its fallback when RoadWise isn't installed.

## Deploy

1. Choose the domain (for example `roadwise.app`).
2. In `.well-known/apple-app-site-association`, replace `TEAMID` with the Apple Developer team ID
   (Xcode or developer.apple.com › Membership). In `w/index.html`, replace `APP_STORE_ID` with the
   app's App Store id.
3. In `.well-known/assetlinks.json`, replace the two placeholders with the SHA-256 fingerprints of the
   certificates the Android app is signed with, as colon-separated upper-case hex
   (`AB:CD:...`, 32 pairs):
   - `PLAY_APP_SIGNING_SHA256`: Google Play's app signing key, which signs every copy Play installs.
     Play Console › RoadWise › Test and release › Setup › App signing › "App signing key
     certificate" › SHA-256 certificate fingerprint. It exists once the first app bundle has been
     uploaded (Play App Signing is on by default).
   - `UPLOAD_KEY_SHA256`: the upload key, which signs the builds EAS makes (the preview APKs testers
     install directly). The same App signing page shows it under "Upload key certificate", or run
     `eas credentials -p android` and read the keystore's SHA-256. With the keystore file itself:
     `keytool -list -v -keystore <file>.jks -alias <alias>` and copy the `SHA256:` line.
   Copy the fingerprints exactly; one wrong character and Android quietly treats the links as plain
   web links. Play Console › Grow users › Deep links shows a ready-made `assetlinks.json` to compare.
4. Host this folder at the domain's root, over https:
   - Serve `/.well-known/apple-app-site-association` with `Content-Type: application/json`, with no
     redirect (Apple's CDN fetches it directly and rejects redirects) and no `.json` extension.
   - Serve `/.well-known/assetlinks.json` with `Content-Type: application/json`, over https, with no
     redirect (Android's verifier does not follow them).
   - Serve `w/index.html` for every `/w/<id>` path (a rewrite of `/w/*` to `/w/index.html`).
5. Set `ROADWISE_LINK_DOMAIN=<domain>` for EAS builds (an EAS environment variable) and locally.
   `app.config.ts` then adds `applinks:<domain>` to the iOS associated domains, a verified App Link
   (`https://<domain>/w/...`, `autoVerify`) to the Android app, and `extra.linkDomain`, which the app
   uses to build and accept `https://<domain>/w/<id>` links.
6. Make a new iOS and Android build: associated domains and App Links change the native project, so
   this can't ship as an over-the-air update. Set `EXPO_APPLE_TEAM_ID` too if it isn't already.
7. Check it: on an iPhone with the new build, open `https://<domain>/w/<id>` from Notes or Messages;
   it should open the Wrapped in RoadWise. Apple's CDN can take up to a day to pick up a changed
   association file. On an Android phone with the new build, `adb shell pm get-app-links
   com.lurp.safedrive` should show the domain as `verified` (`adb shell pm verify-app-links
   --re-verify com.lurp.safedrive` asks again after a change), and the same link opened from
   Messages or Gmail should open the Wrapped in RoadWise. Google's
   [Statement List tester](https://developers.google.com/digital-asset-links/tools/generator) checks
   the file from the web.

# Third-party notices: the RoadWise app

This lists the open-source software and data that ship inside the RoadWise app binaries, and their licences.
- The map data sources are described in more detail in [`THIRD_PARTY.md`](THIRD_PARTY.md). That file stays the record for `supabase/data`.
- Versions are those in `package.json`, and for native libraries those the linked modules declare (their `build.gradle` and podspecs), on 2026-11-21. Gradle and CocoaPods may resolve a newer one where two modules ask for different versions.
- Regenerate the npm list when dependencies change: read `license` from each `node_modules/<dep>/package.json` for the runtime dependencies. Regenerate the native table from the `build.gradle` and podspec of every module the app links (the app's own in `modules/` too), reading each licence from the artifact's POM or podspec. Development-only modules (the dev client's launcher and menu) never reach a store build and are left out.

## Native libraries

| Component | Version | Licence | Ships in |
|---|---|---|---|
| Expo Modules Core | SDK 57 | MIT | every build |
| Hermes and Yoga | React Native 0.86.3's | MIT | every build (React Native) |
| Folly | 2024.11.18.00 | Apache-2.0 | every build (React Native) |
| glog | 0.3.5 | BSD-3-Clause | every build (React Native) |
| double-conversion | 1.1.6 | BSD-3-Clause | every build (React Native) |
| fmt | 12.1.0 | MIT | every build (React Native) |
| fast_float | 8.0.0 | MIT, Apache-2.0 or BSL-1.0 | every build (React Native) |
| Boost | 1.84.0 (iOS), 1.83.0 (Android) | BSL-1.0 | every build (React Native) |
| SQLite | 3.50.3 | Public domain | every build (`expo-sqlite`; iOS also through `expo-updates`' `sqlite3` pod) |
| fbjni, SoLoader | 0.7.0, 0.12.1 | Apache-2.0 | Android (React Native) |
| Fresco | 3.6.0 | MIT | Android (React Native) |
| Kotlin standard library, kotlinx.coroutines | the build's Kotlin; coroutines 1.10.2 | Apache-2.0 | Android (every module) |
| AndroidX CameraX (`androidx.camera:*`, with `camera-mlkit-vision`) | 1.6.0 | Apache-2.0 | Android (`expo-camera`, friend QR codes) |
| AndroidX Credential Manager (`androidx.credentials:credentials`, `credentials-play-services-auth`) | 1.5.0 | Apache-2.0 | Android (`modules/google-credential`, Google sign-in) |
| Other AndroidX libraries (`androidx.core` 1.17.0, `appcompat` 1.7.1, Media3 1.9.0, Room 2.6.1 and 2.8.3, WorkManager 2.9.1, Biometric 1.1.0, Browser 1.6.0, Fragment, Lifecycle, Jetpack Compose and what they depend on) | as named | Apache-2.0 | Android (React Native, Expo modules, `react-native-screens`, `react-native-maps`, `modules/drive-sense`, `modules/google-credential`) |
| Material Components for Android (`com.google.android.material:material`) | 1.13.0 | Apache-2.0 | Android (`expo-router`, `react-native-screens`, `@expo/ui`) |
| Google Play services location (`com.google.android.gms:play-services-location`) | 21.3.0 | Android Software Development Kit License | Android (`modules/drive-sense`, `expo-location`, `react-native-maps`) |
| Google Play services base and Maps (`play-services-base`, `play-services-maps`) | 18.5.0, 19.1.0 | Android Software Development Kit License | Android (`react-native-maps`, the trip map) |
| Maps SDK for Android Utility Library (`com.google.maps.android:android-maps-utils`) | 3.10.0 | Apache-2.0 | Android (`react-native-maps`) |
| Google ID (`com.google.android.libraries.identity.googleid:googleid`) | 1.1.1 | Android Software Development Kit License | Android (`modules/google-credential`, Google sign-in) |
| Firebase Cloud Messaging (`com.google.firebase:firebase-messaging`, with the Firebase and Play services libraries it depends on) | 25.0.1 | Apache-2.0 (the Play services parts: Android Software Development Kit License) | Android (`expo-notifications`, server pushes) |
| ML Kit barcode scanning, Google code scanner (`com.google.mlkit:barcode-scanning`, `play-services-code-scanner`) | 17.3.0, 16.1.0 | ML Kit Terms of Service | Android (`expo-camera`, friend QR codes) |
| Play Install Referrer (`com.android.installreferrer:installreferrer`) | 2.2 | Android Software Development Kit License | Android (`expo-application`) |
| ShortcutBadger (`me.leolin:ShortcutBadger`) | 1.1.22 | Apache-2.0 | Android (`expo-notifications`) |
| Glide, with its AVIF and OkHttp integrations (`com.github.bumptech.glide:*`) | 5.0.5 | BSD-2-Clause and Apache-2.0 | Android (`expo-image`) |
| AndroidSVG (`com.caverock:androidsvg-aar`) | 1.4 | Apache-2.0 | Android (`expo-image`) |
| APNG and animated WebP for Glide (`com.github.penfeizhou.android.animation:glide-plugin`) | 3.0.5 | Apache-2.0 | Android (`expo-image`) |
| Glide Transformations (`jp.wasabeef:glide-transformations`) | 4.3.0 | Apache-2.0 | Android (`expo-image`) |
| OkHttp, Okio (`com.squareup.okhttp3:*`, `com.squareup.okio:okio`) | 4.9.2; Okio 2.9.0 to 3.16.0 | Apache-2.0 | Android (React Native, Expo modules) |
| zstd-kmp (`com.squareup.zstd:zstd-kmp-okio`) | 0.4.0 | Apache-2.0 (the Zstandard library in it: BSD-3-Clause) | Android (`expo`, `expo-updates`) |
| Brotli decoder (`org.brotli:dec`) | 0.1.2 | MIT | Android (`expo`, `expo-updates`) |
| Bouncy Castle (`org.bouncycastle:bcutil-jdk15to18`) | 1.81 | Bouncy Castle Licence (MIT) | Android (`expo-updates`, update signatures) |
| Apache Commons Codec, Apache Commons IO | 1.10, 1.4 | Apache-2.0 | Android (`expo-file-system`) |
| Gson (`com.google.code.gson:gson`) | 2.8.6 | Apache-2.0 | Android (`@expo/log-box`) |
| Pika (`io.github.lukmccall.pika:pika-api`) | 0.3.2 | MIT | Android (Expo Modules Core) |
| SocketRocket | React Native 0.86.3's | BSD-3-Clause | iOS (React Native) |
| SDWebImage | ~> 5.21.0 | MIT | iOS (`expo-image`) |
| SDWebImageWebPCoder, SDWebImageAVIFCoder, SDWebImageSVGCoder | ~> 0.14.6, ~> 0.11.0, ~> 1.7.0 | MIT | iOS (`expo-image`) |
| libwebp | as the WebP coder pins it | BSD-3-Clause | iOS (`expo-image`) |
| libavif, dav1d (`libavif/libdav1d`) | as CocoaPods resolves | BSD-2-Clause | iOS (`expo-image`) |
| Reachability.swift (`ReachabilitySwift`) | as CocoaPods resolves | MIT | iOS (`expo-updates`) |

## JavaScript dependencies (runtime)

All MIT unless noted:

- **React and React Native:** `react` 19.2.3, `react-dom` 19.2.3, `react-native` 0.86.3.
- **Expo SDK 57:** `expo`, `expo-apple-authentication`, `expo-asset`, `expo-audio`, `expo-auth-session`, `expo-battery`, `expo-camera`, `expo-constants`, `expo-crypto`, `expo-dev-client`, `expo-device`, `expo-file-system`, `expo-font`, `expo-haptics`, `expo-image`, `expo-keep-awake`, `expo-linear-gradient`, `expo-linking`, `expo-location`, `expo-network`, `expo-notifications`, `expo-observe` (with `expo-app-metrics` and `expo-eas-client`: crash and startup reports to EAS Observe), `expo-print` (prints the permit practice log to a PDF), `expo-router`, `expo-screen-capture` (keeps the DashPal aiming picture out of screenshots and the app switcher), `expo-secure-store`, `expo-sharing`, `expo-speech`, `expo-splash-screen`, `expo-sqlite`, `expo-status-bar`, `expo-system-ui`, `expo-updates`, `expo-web-browser`, `@expo/ui` (a dependency of `expo-router`), and `@expo/vector-icons` (which bundles the Ionicons font, MIT).
- **Navigation, gesture and animation:** `react-native-screens`, `react-native-safe-area-context`, `react-native-gesture-handler`, `react-native-reanimated`, `react-native-worklets`.
- **Graphics and maps:**
  - `react-native-svg`, `react-native-qrcode-svg` and `react-native-view-shot`
  - `react-native-maps`. The map tiles themselves come from Apple Maps on iOS and Google Maps on Android, under those platforms' terms.
- **Data:** `@supabase/supabase-js`, `@tanstack/react-query`, `zustand`, `zod`, `@react-native-async-storage/async-storage`, `react-native-get-random-values`.
- **DashPal link:** `react-native-ble-manager` (**Apache-2.0**) for Bluetooth LE, and `@noble/ciphers`, `@noble/curves` and `@noble/hashes` for its X25519 key agreement and AES-GCM encryption. `@noble/ciphers` also encrypts the stored sign-in session (AES-256-CTR, its key in the Keychain / Keystore).
- **Fonts:** `@expo-google-fonts/barlow-semi-condensed`. The package is MIT; the typeface is under the **SIL Open Font License 1.1**: Barlow Semi Condensed (Copyright 2017 The Barlow Project Authors, https://github.com/jpt/barlow).

The MIT licence text is reproduced in [`THIRD_PARTY.md`](THIRD_PARTY.md). The other licences:
- Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0
- BSD-2-Clause and BSD-3-Clause: https://opensource.org/license/bsd-2-clause and https://opensource.org/license/bsd-3-clause
- Boost Software License 1.0: https://www.boost.org/LICENSE_1_0.txt
- Bouncy Castle Licence: https://www.bouncycastle.org/licence.html
- Android Software Development Kit License: https://developer.android.com/studio/terms
- ML Kit Terms of Service: https://developers.google.com/ml-kit/terms
- SIL OFL 1.1: https://openfontlicense.org

## Data

- **Speed limits:**
  - OpenStreetMap data, © OpenStreetMap contributors, under the Open Database License 1.0.
  - HPMS 2024 (FHWA and BTS), a U.S. Government work.
  - Full attribution is in [`THIRD_PARTY.md`](THIRD_PARTY.md). Where neither source has a limit, Amazon Location Service is asked, under AWS's service terms.
- **Weather:** the sky's weather, the dangerous-weather alerts (Home and the driving screen) and the road conditions that make a drive's lines stricter come from Open-Meteo's forecast API (api.open-meteo.com), weather data by Open-Meteo.com under CC BY 4.0. It is sent a position rounded to one decimal (about 10 km), never the exact position. The alert thresholds follow published US National Weather Service criteria; the stricter lines follow FHWA road-weather speed studies, FHWA's variable speed limit guidance for low visibility and AASHTO stopping sight distance.
- **Sounds:** the alert tones (`assets/sounds/l1.wav` to `l3.wav`) and the DashPal tones (`dp_glance.wav`, `dp_drowsy.wav`, `dp_wake.wav`, `dp_phone.wav`) are generated by `scripts/make-tones.js` and are the project's own.

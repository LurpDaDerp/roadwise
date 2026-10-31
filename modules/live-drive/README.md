# live-drive — the iOS Live Activity / Dynamic Island

Local Expo module (plan §3.1.3, §3.10) that shows the drive in progress on the lock screen and in
the Dynamic Island: the speed, coloured as the driving screen colours it when over the limit (never
pulsing), the speed limit in the driving screen's sign style, a dangerous-weather line when the
driving screen has an alert, and the words "Not driving?" while that option is still available.
iOS 16.2+; everywhere else (older iOS, Android, Jest, web) every method is a no-op that resolves.

```
modules/live-drive/
  src/{types,index,fake}.ts      the JS contract, the wrapper, the test fake
  ios/LiveDriveModule.swift      Expo module: isSupported / isRunning / getPushToStartToken /
                                 start / update / end; the pushToStartToken event
  ios/LiveDriveController.swift  one Activity<LiveDriveAttributes>: adopts, never replaces;
                                 observes roadwise.driveDisplay; the push-to-start token stream
  ios/LiveDriveAppDelegate.swift creates the controller at launch (every process)
  ios/LiveDriveAttributes.swift  ActivityAttributes — byte-identical copy in the widget target
targets/live-drive-widget/       the widget extension (@bacons/apple-targets): expo-target.config.js,
                                 Info.plist, LiveDriveAttributes.swift, LiveDriveWidgetBundle.swift,
                                 WeatherSymbol.swift
```

## API (`src/types.ts` is binding)

| Method / event | Behaviour |
|---|---|
| `isSupported()` | iOS 16.2+ and Live Activities enabled for the app in Settings; `false` elsewhere. |
| `isRunning()` | An activity shows the drive now: one started here, adopted at launch, or started by a push. |
| `getPushToStartToken()` | The push-to-start token (lowercase hex, iOS 17.2+) the phone last received, persisted under `livedrive.pushToStartToken`; `null` before one arrived or below 17.2. |
| `start(state)` | Shows the drive. A running activity (a push-started one included) is **updated, never replaced**; else one is requested. One the driver dismissed (or iOS ended) no longer runs, so the next `start` (the app back in front) requests a new one. Resolves whether one now runs: `false` when unsupported, disabled, or refused (iOS refuses a request from the background); the drive goes on regardless. |
| `update(state)` | Updates the running activity; without one the state is kept as the newest, for an activity adopted later. |
| `end()` | Ends the running activity at once; a no-op without one. Called on drive end or cancel. |
| `pushToStartToken` event | `{ token }` each time iOS hands the app a new push-to-start token (iOS 17.2+). The app registers it with RoadWise's server (`register_device`), which starts the activity by APNs for a drive that starts with the app in the background. |

`LiveDriveState`: `speed`, `limit` (in `unit`; `null` shows "-"), `unit` (`mph` draws the US SPEED
LIMIT plate, `km/h` the round red-ringed sign), `speedTint` ("#RRGGBB", the driving screen's numeral
at its speeding tint; `null` = white), `speeding` (VoiceOver only), `notDrivingAvailable` (the hint
shows), `weatherKind` / `weatherText` (a `DangerKind` id and its line, `null` = no line), and the
app's sky (`skyTop`, `skyMid`, `skyLow`, `accent`). A bad state rejects
(`LiveDrive.<method>: invalid state …`) on every platform: the caller has a bug whatever the device.
Nothing else rejects; a token that is not hex is dropped.

## Adoption, not replacement

At launch (`LiveDriveAppDelegate`) and at module creation the controller adopts a running activity
while a drive is open — `UserDefaults "drivesense.captureOpen"`, the one key shared with drive-sense
— and ends any other; with no drive open every activity is stale and ends. A push-started activity
arrives through `Activity.activityUpdates` and is adopted the same way (a duplicate is ended).
`DriveSense.setDriveDisplay(state)` reaches the activity too — drive-sense posts the process-local
`roadwise.driveDisplay` notification, which the controller maps to a content state (`ended: true`
ends it) — and every drive end or cancel in drive-sense posts `ended`, so the activity never
outlives its drive. The controller keeps the drive's newest display state (from `start`, `update`
or `roadwise.driveDisplay`) even while it holds no activity: a pushed activity adopted later shows
that state at once instead of its pushed one (often without a speed or a limit), so nothing sent
while waiting for the push is lost. A kept state older than the 120 s stale window is left out,
and `end` (or `ended`) forgets it, so the next drive never shows the last one's. Every content carries a `staleDate` 120 s out: with no update for that long (the
app was killed) the widget shows "-" and hides the hint and the weather line (`context.isStale`).

Whenever the running activity changes the controller posts `roadwise.liveActivity`
(`["running": Bool]`), and an activity that runs takes drive-sense's "Recording your drive" note
(`roadwise.driveRecording`) down: the driver sees the Live Activity or the note, never both.

## Widget

`targets/live-drive-widget/expo-target.config.js` declares a `widget` target (iOS 16.2, SwiftUI +
WidgetKit + ActivityKit) in the navy/gold palette (`$widgetBackground` #001D3D, `$accent`
#FFC300). `LiveDriveWidgetBundle.swift` renders:

- **Lock screen:** the speed (52 pt, tinted) with its unit, and the sign (56 pt tall); under them the
  weather line (its SF Symbol and text, 13 pt semibold, white at 0.9) when there is one, and
  "Not driving?" (13 pt semibold, white at 0.7, trailing) while it is available. The app's sky behind.
- **Dynamic Island, expanded:** the speed (40) leading, the sign (44) trailing, and a bottom row with
  the weather line and the hint, each only when present. **Compact:** the tinted speed and a mini
  sign (a 16 × 20 plate with the number only in mph, the 20 pt round sign in km/h). **Minimal:** the
  tinted speed.
- `-` for an unknown speed or limit. A tap anywhere opens `roadwise://drive`. Nothing is interactive.
- VoiceOver: "Speed 34 miles per hour" (", over the limit" while speeding), "Speed limit 35" /
  "Speed limit unknown", the weather line as its text.

`WeatherSymbol.swift` maps every `DangerKind` (`src/features/weather/danger.ts`) to an SF Symbol
available on iOS 16. `LiveDriveAttributes.swift` must stay byte-identical in `modules/live-drive/ios`
and `targets/live-drive-widget`; `__tests__/native-ios.test.ts` compares the two files.

`app.config.ts` loads `@bacons/apple-targets` and sets `NSSupportsLiveActivities: true` and
`NSSupportsLiveActivitiesFrequentUpdates: true` (the larger update budget; the driver can turn it off
in Settings › RoadWise › Live Activities). Updates come about once a second while RoadWise is behind
and once a minute while it is in front, where nobody sees the activity (`src/drive/display.ts`
`setFront`), so the budget goes to the screen-off lock screen. The
extension is signed with `ios.appleTeamId` (from `EXPO_APPLE_TEAM_ID`); without it, `npx expo
prebuild` warns and Xcode asks for a team.

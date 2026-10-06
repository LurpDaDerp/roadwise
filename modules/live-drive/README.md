# live-drive — the iOS Live Activity / Dynamic Island

Local Expo module (plan §6; spec "Driving screen · Background") that shows the drive in progress
on the lock screen and in the Dynamic Island: speed (large), a round speed-limit sign, and the
points line only when points are present (the host sends them only while stopped). iOS 16.2+;
everywhere else (older iOS, Android, Jest, web) every method is a no-op that resolves.

```
modules/live-drive/
  src/{types,index,fake}.ts      the JS contract, the wrapper, the test fake
  ios/LiveDriveModule.swift      Expo module: isSupported / start / update / end
  ios/LiveDriveController.swift  one Activity<LiveDriveAttributes>; observes roadwise.driveDisplay
  ios/LiveDriveAttributes.swift  ActivityAttributes — byte-identical copy in the widget target
targets/live-drive-widget/       the widget extension (@bacons/apple-targets): expo-target.config.js,
                                 Info.plist, LiveDriveAttributes.swift, LiveDriveWidgetBundle.swift
```

## API (`src/types.ts` is binding)

| Method | Behaviour |
|---|---|
| `isSupported()` | iOS 16.2+ and Live Activities enabled for the app in Settings; `false` elsewhere. |
| `start(state)` | Start the activity with `state` (`LiveDriveState`: `{ speed, limit, unit, points, pointsDelta, stopped }`). **Only ever called by a drive start.** Ends any activity still running first. Resolves whether an activity is now running — `false` when unsupported, disabled, or refused by the system; the drive goes on regardless. |
| `update(state)` | Update the running activity; a no-op without one. |
| `end()` | End the running activity at once; a no-op without one. Called on drive end or abort. |

The module also **ends every stale activity at creation** (`OnCreate`): nothing from an earlier
process may linger. `DriveSense.setDriveDisplay(state)` reaches the activity too — drive-sense
posts the process-local `roadwise.driveDisplay` notification, which the controller maps to a
content state (`ended: true` ends it) — so the host needs one call per update, not two.

A bad `state` rejects (`LiveDrive.<method>: invalid state …`) on every platform: the caller has a
bug whatever the device. Nothing else rejects.

## Widget

`targets/live-drive-widget/expo-target.config.js` declares a `widget` target (iOS 16.2, SwiftUI +
WidgetKit + ActivityKit) in the navy/gold palette (`$widgetBackground` #001D3D, `$accent`
#FFC300). `LiveDriveWidgetBundle.swift` renders:

- **Lock screen:** speed (large, white, rounded digits) with the unit under it; the limit as a
  round white sign with a gold ring; the points line in gold only when points are present.
- **Dynamic Island, expanded:** speed (leading), limit sign (trailing), points (bottom) only when
  stopped and present. **Compact:** speed | limit sign. **Minimal:** speed.
- `—` for an unknown speed or limit. Nothing is interactive.

`LiveDriveAttributes.swift` must stay byte-identical in `modules/live-drive/ios` and
`targets/live-drive-widget` (ActivityKit matches the activity to its widget by that type);
`__tests__/native-ios.test.ts` compares the two files.

`app.config.ts` loads `@bacons/apple-targets` and sets `NSSupportsLiveActivities: true`. The
extension is signed with `ios.appleTeamId` (from `EXPO_APPLE_TEAM_ID`); without it, `npx expo
prebuild` warns and Xcode asks for a team.

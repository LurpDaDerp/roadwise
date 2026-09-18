# RoadCash / RoadWise — UX audit (pre-rework, 2026-09-18)

Scope: every file under `App.js`, `navigation/`, `screens/`, `context/`, `hooks/`, `theme/`, `utils/`,
`app.json`, `README.md`, `TODO.md` on branch `main` (`3509719`). This is the state the rework starts from.

## 1. Feature inventory per screen

| Screen | Lines | What it does today | Reached from |
|---|---|---|---|
| `DashboardScreen` | 700 | Greeting, streak flame pill, "Start driving" hero, Points/Drives/Streak row, AI safety score (from AsyncStorage `safetyScore`), "View full driver report" button, "My group" button, post-drive snackbar + confetti driven by AsyncStorage flags | Dashboard tab root |
| `DriveScreen` | 1,878 | Live drive: GPS speed (1 s / 10 m), HERE speed-limit reverse geocode with a grid + polyline cache, points timer (+1 every 2.5 s while moving and under 125 % of the limit), speeding modal + looping tone + pulsing limit card, spoken speed-limit changes, phone-use distraction via `AppState` (>5 s away = distracted, streak reset; 2 min away = drive auto-ends), emergency modal (911 / notify group / call trusted contacts), weather panel (icon, temp, visibility, precipitation, chance of rain, AQI), GPT road-condition summary, "Complete Drive" button, finalization (drive metrics doc, streak, AsyncStorage hand-off to Dashboard) | Dashboard → hero card |
| `LocationScreen` | 2,051 | Family group: create/join by 6-char code, live map with member markers (photo pins, pulsing ring in emergency), bottom sheet with members (driving badge, address via Nominatim reverse geocode + 7-day cache) and saved locations (HERE autocomplete, edit/delete), member detail modal (copy address, last update, speed), leave group; deep-link target for emergency push notifications | Dashboard → "My group"; push-notification tap |
| `MyDrivesScreen` | 421 | Summary (drives / focused / % distracted), paginated list, detail modal with 8 metrics, "Clear drive history" (destructive, unguarded beyond one alert) | AIScreen → "View all drives" only |
| `AIScreen` | 545 | Timeframe segmented control (day/week/month), line chart of phone distractions, focus counts, driving-dynamics metrics, "Get personalized feedback" (needs ≥10 mi and ≥500 s), link to MyDrives | Dashboard → score card / insights button |
| `AIFeedbackScreen` | 342 | Lottie loader with fake progress messages, GPT feedback (score, summary, tips) with a 10-entry cache keyed on the stats JSON; writes `safetyScore` to AsyncStorage | AIScreen |
| `LeaderboardScreen` | 251 | Top 50 by points, medal icons, "Your rank" row when outside top 50 (`getCountFromServer`) | Leaderboard tab |
| `RewardsScreen` | 212 | Balance card, four category cards | Rewards tab |
| `Food/Shopping/Games/SubscriptionsRewardsScreen` + `_ComingSoon` | 6 ×4 + 76 | Full-screen "Coming soon" | Rewards categories |
| `LoginScreen` / `SignUpScreen` | 170 / 171 | Email + password, Google (owner reports broken), username uniqueness check | Dashboard stack when signed out |
| `SettingsScreen` | 82 | Four category rows | Settings tab root |
| `GeneralSettings` | 80 | Theme segmented control (light / dark / system) | Settings |
| `DriveScreenSettings` | 142 | Speed unit; toggles: show speed, show limit, spoken limit updates, speeding warnings, distracted notifications, show lifetime points | Settings |
| `SafetySettings` | 284 | Trusted contacts (add / delete, 10-digit validation) | Settings |
| `AccountSettings` | 388 | Avatar upload (Supabase), username edit with uniqueness check, email, group, points, "Switch account" and "Sign out" (identical behaviour) | Settings |
| `AboutScreen` | 115 | Mission statement and statistics | About tab AND Dashboard stack |

Cross-cutting: `App.js` (5 tabs, notification-tap routing, 10-minute inactivity reset), `ThemeContext`
(light/dark/system), `DriveContext` (a single boolean nobody reads), `useAuth` (unused by any screen),
`utils/LocationService` (background location task for group sharing), `utils/notifications`,
`utils/firestore`, `utils/here`, `utils/weather`, `utils/gptApi`, `utils/supabase`.

## 2. Flows as they exist

- **Sign-in gate is leaky.** Only the Dashboard stack swaps to Login/SignUp when signed out; the
  Rewards, Leaderboard, Settings and About tabs stay reachable and render with `auth.currentUser == null`
  (Account shows "Not logged in", Leaderboard still queries). There is no welcome / first-run experience.
- **No onboarding and no permission story.** Location is requested by `startLocationUpdates()` at app launch
  (foreground *and* background, before the user has done anything), notifications are requested in
  `App.js` on mount, and again on the Drive screen and Family screen. Nothing explains why. Camera is not
  requested anywhere, yet `NSCameraUsageDescription` talks about "scanning QR codes".
- **Starting a drive is implicit.** Tapping the hero card mounts `DriveScreen`, which immediately starts
  the point timer, GPS watch, weather and GPT calls. There is no readiness check (location permission is
  requested *inside* the drive), no way to confirm the phone is mounted, no explicit start.
- **Ending a drive returns to the Dashboard with a snackbar.** `finalizeDrive()` writes AsyncStorage flags
  (`@driveCompleteSnackbar`, `@pointsThisDrive`, `@driveWasDistracted`) that the Dashboard consumes on focus
  to add the points, animate and fire confetti. There is no summary of what happened, no per-drive score,
  no "what to improve", and points only reach Firestore when the Dashboard happens to focus.
- **Drive history is hidden.** `MyDrives` is reachable only through AI → "View all drives"; the Dashboard
  has no recent-drives list.
- **Insights are three screens deep** (Dashboard → AI report → Feedback) and the safety score on the
  Dashboard is whatever the *last* generated feedback wrote to AsyncStorage (per device, not per user).

## 3. Pain points

### Navigation and structure
1. **About is both a tab and a stack screen** (`App.js` tab + `StackNavigator` route). A mission statement
   does not deserve a permanent tab slot.
2. **Settings is both a tab and a nested stack** inside the Dashboard stack (`SettingsStack`), and Login
   navigates to `Settings › SettingsMain` for no reason.
3. **Four placeholder reward screens** plus `_ComingSoon` exist only to say "coming soon"; the Rewards tab
   is a dead end that also shows the wrong balance (reads AsyncStorage key `totalPoints`, but the Dashboard
   writes `totalPoints_<uid>`; result: 0).
4. **Tab bar is hidden by hand** (`tabBarStyle: { display: 'none' }`) in Drive, AI, Login and Family via
   `useLayoutEffect`; flicker and state leaks when a screen unmounts abnormally.
5. **10-minute inactivity reset** in `App.js` throws the user back to the Dashboard root whenever the app
   was backgrounded for 10 min, discarding whatever they were doing (adding a saved location, reading
   feedback). The README calls it "Automatic Session Management"; it is a stale-screen workaround.
6. `@react-navigation/drawer` is imported and a `Drawer` created but never rendered.
7. Unused / vestigial: `DriveContext` (written, never read), `hooks/useAuth` (never imported),
   `dist`/`.expo` clean-ups, `testcoordinates`, `opacity` Animated value applied to a non-animated gradient
   (always 0, silently ignored), `showCurrentSpeed` setting (not used by the Drive screen), `phoneUsageTime`
   (always 0 — `phoneUsageStart` is never set).

### Drive screen (the screen the user cannot read)
8. **Information density while driving is far too high**: two 72-pt speed cards, a points/distractions
   row, a 220-px weather panel with six numbers (visibility, precipitation, chance of rain, AQI value, AQI
   label, temperature), a GPT road summary, an emergency button and a "Complete Drive" button all compete.
   AQI has no bearing on driving.
9. **Speeding alert is a modal with a "Dismiss" button** — it asks for a touch precisely when the driver
   should not touch the phone, and it blocks the emergency button.
10. **No keep-awake.** The screen dims and locks on a dash mount; when the phone locks, `AppState` becomes
    `inactive`, which the distraction logic counts as phone use.
11. **"Complete Drive" is a single tap** in the middle of the layout — easy to hit by accident.
12. **Speed limit falls back to 25 mph silently** when HERE has no data or the fetch is throttled, and the
    limit card looks identical whether the value is real or a default.
13. Distraction state is shown only by the colour of the points number.
14. Everything (GPS, speed limits, weather, GPT, points, AppState, emergency, finalization, layout) lives
    in one 1,878-line component with 40+ refs; nothing is testable or reusable.

### Data and correctness
15. Points are transported through AsyncStorage and merged on Dashboard focus; a crash between the two
    loses the drive's points. `saveUserPoints` overwrites with a device-local total.
16. Group creation never writes `groupName` to `groups/{id}` (only the user's `groupId`), so the name is
    lost after the first reload; `startLocationUpdates` then creates the group doc implicitly.
17. Family screen requests background location + notifications on mount and kicks the user out with an
    alert if either is denied — no inline recovery.
18. `Location` reverse geocoding for members uses Nominatim directly from the client with a hard-coded UA.
19. `LeaderboardScreen` fetches once per app session (no focus refresh, no pull-to-refresh).
20. Safety score is per device (AsyncStorage) and never expires.

### Visual and interaction
21. Copy is inconsistent ("RoadCash" in `app.json`, "RoadWise" everywhere else), several screens use a
    right-aligned `ScreenHeader` purely to dodge the back chevron.
22. Empty states exist for contacts, drives and leaderboard but not for the Dashboard (new user sees
    "—" and "No score yet"), Family (a full-screen form) or Rewards.
23. Loading states: Dashboard shows a spinner over content that is already visible; Family shows a bare
    `ActivityIndicator` on a white view; AI Feedback fakes progress with random delays.
24. Error states: network / permission failures mostly `console.warn`; the drive screen shows
    "Loading summary…" forever if GPT fails.
25. Settings are flat toggles with no grouping by what they affect; there is no place for driver
    monitoring, alert style, sensitivity or driver side.

## 4. Onboarding gaps
- No welcome, no explanation of the loop (drive → stay focused → earn → redeem).
- No permission primer; all three permissions are demanded by side effects.
- No camera-mount guidance, no driver-side selection.
- No "what counts as distracted" explanation until the streak is already lost.

## 5. Error / empty / loading state matrix (before)

| Screen | Loading | Empty | Error |
|---|---|---|---|
| Dashboard | spinner overlay (flash) | "—" placeholders | console only |
| Drive | "Loading weather data…" / "Loading summary…" | n/a | Alert on location denial, then a dead screen |
| Family | bare spinner | join/create form | Alert + goBack |
| My drives | none | yes | none |
| AI report | none | "No data for selected timeframe" | Alert for insufficient data |
| AI feedback | Lottie + fake messages | n/a | text in the summary card |
| Leaderboard | spinner in card | "No entries yet." | console only |
| Rewards | none | n/a | n/a |
| Account | full-screen spinner | n/a | Alert |

## 6. What is worth keeping
- The design system (`theme/tokens.js`, `theme/primitives.js`) is coherent and glance-friendly; keep it.
- Drive metrics fields and the `users/{uid}` / `users/{uid}/drivemetrics` layout (other branches depend on it).
- Speed-limit grid/polyline cache, weather + road-summary throttling, phone-use detection semantics
  (>5 s away = distracted, 2 min = drive ends), streak rule, points cadence.
- Family group data model (`groups/{id}.memberLocations`, `savedLocations`), the background location task,
  the emergency Cloud Function contract (`memberLocations.<uid>.emergency`).
- AI feedback cache and the Cloud Function API.

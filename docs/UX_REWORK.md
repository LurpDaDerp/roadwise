# RoadWise UX rework — design and contracts (branch `ux-rework`)

Companion to `docs/UX_AUDIT.md`. Visual language is unchanged: `theme/tokens.js` and
`theme/primitives.js` (extended, never restyled). This document is the source of truth for the
information architecture, every screen, the driver-monitoring mount-point contract, settings keys and
the Firestore fields the rework reads and writes.

## 1. Product loop the UX is built around

**Mount → Start → Drive (glance only) → Summary → Improve → Earn/Compete.**
Everything on the Home tab points at "Start drive"; everything after a drive points at the summary and
the history; the Rewards tab turns points, streaks and badges into something to come back for; Family is
the safety net; Settings holds everything that is configured once.

## 2. Information architecture and navigation map

```
RootNavigator (native stack, headerless)
├─ Splash                       while Firebase Auth initialises
├─ Auth (signed out)
│    ├─ Welcome                 brand, value proposition, "Get started" / "Log in"
│    ├─ Login                   email + password, show/hide, forgot password, Google
│    └─ SignUp
├─ Onboarding (signed in, `@onboarded_<uid>` unset)   4 pages, see §4
├─ Main (bottom tabs)
│    ├─ Home        HomeScreen
│    ├─ Drives      DrivesStack:  Drives (History | Insights) → DriveDetail → AIFeedback
│    ├─ Rewards     RewardsStack: Rewards → Leaderboard
│    ├─ Family      FamilyScreen (map + sheet; create/join panel when not in a group)
│    └─ Settings    SettingsStack: Settings → Account | Driving | Monitoring | Safety | Notifications | About
└─ Drive group (full-screen, presented over Main, no tab bar, swipe-back disabled)
     ├─ DrivePrep               readiness check + camera placement + explicit Start
     ├─ Drive                   the live drive
     └─ DriveSummary            what happened, points, what to improve
```

Removed: the About tab, the duplicated Settings stack inside the Dashboard stack, the four placeholder
reward screens and `_ComingSoon`, `MyDrivesScreen` (→ Drives tab), `AIScreen` (→ Insights panel),
`LocationScreen` (→ FamilyScreen, split into components), the drawer import, the 10-minute inactivity
reset, `tabBarStyle: display none` hacks (full-screen routes now live outside the tab navigator),
`DriveContext` (replaced by route params) and the AsyncStorage hand-off of drive results.

Deep links: an emergency push notification navigates to `Main › Family` with `{ emergencyUid }`.

## 3. Screen-by-screen

### Welcome / Login / SignUp
- Welcome: logo mark, one-line promise ("Drive focused. Earn rewards."), three-step loop, primary
  "Create account", secondary "Log in".
- Login: email, password with show/hide, loading state on the button, inline error text (no Alert for
  wrong credentials), "Forgot password?" → `sendPasswordResetEmail` with an inline confirmation, Google.
- SignUp: same inputs plus username with live availability hint; inline validation.

### Onboarding (first run per user per device)
1. **How it works** — three cards: Start a drive · Stay focused (phone down, eyes on the road) · Earn
   points, streaks and rewards.
2. **Permissions** — one row per permission with the *reason* and a button:
   - Location (required): speed, speed limits and distance. Background location is only asked for when
     the user joins a family group.
   - Notifications (recommended): distraction warnings and family emergencies.
   - Camera (optional): driver monitoring through the front camera; frames never leave the phone.
3. **Mount your phone** — camera placement guide (dash mount, front camera facing you, screen visible),
   driver-side selector (left / right), "Enable driver monitoring" toggle.
4. **Ready** — summary of what is on, "Go to Home".
Skippable at any page ("Skip for now"); re-openable from Settings › About › "Replay onboarding".

### Home (was Dashboard)
- Header: greeting + streak flame pill; tapping the pill explains the streak rule.
- **Start drive** hero (image card) → DrivePrep. Subtitle shows monitoring state ("Monitoring on · mounted
  left") or "Set up monitoring".
- Stats row: Points · Drives · Streak (animated counters kept).
- **This week** card: drives, focused %, minutes driven, eyes-off-road seconds (when monitoring data exists).
- **Safety score** card: AI score with heat bar when present, otherwise a CTA to Insights.
- **Recent drives** (last 3, score chip, points) → DriveDetail; "See all" → Drives tab.
- **Family** card: members and any active emergency, or "Set up family safety".
- Empty state for a new account: hero + a "Your first drive" checklist replacing the stats.
- Post-drive celebration moved to DriveSummary; Home only refreshes.

### DrivePrep (new)
- Readiness list with live status: Location permission · Notifications · Camera (only when monitoring
  is enabled) · GPS fix. Each row has a fix action (request / open settings).
- **Camera placement guide** (`CameraPlacementGuide`) with the driver-side selector and a monitoring
  on/off toggle for this drive.
- Speed unit and alert style summary with a link to Driving settings.
- Big primary **Start drive** (disabled until location is granted). "Not now" returns Home.

### Drive (rebuilt for glanceability)
Portrait layout, top to bottom, every element readable at arm's length:
1. Top bar: **SOS** round button (left), `MonitoringStatusPill` (centre), elapsed time (right).
2. **Alert slot** (`AlertBanner`): INFO / WARNING monitoring alerts, speeding, phone-use; never a modal.
   `CalibrationGate` renders in the same slot while calibrating.
3. **Speed hero**: current speed at ~120 pt, colour teal → amber → red by margin over the limit, unit
   under it; the speed limit as a road-sign badge (`SpeedLimitSign`) with an "est." marker when the
   value is the 25 mph default.
4. **Points card**: points this drive (large), shield state Focused / Distracted, "+1" pulses.
5. **Conditions strip**: weather icon, temperature, 3–6 word road summary with severity colour. The
   full weather panel is gone (visibility, precipitation, rain chance and AQI are folded into the
   summary).
6. **Hold to end** button (press and hold 1.2 s with a fill animation; no accidental ends).
7. `CriticalOverlay` mounts above everything for CRITICAL monitoring alerts (full-screen, pulsing,
   huge text, no buttons).
Behaviour kept: GPS watch, speed-limit cache, points cadence, spoken limit changes, speeding tone loop,
phone-use detection (>5 s away = distracted, 2 min = drive auto-ends), emergency sheet (911 / notify
group / trusted contacts). New: `useKeepAwake`, alert audio policy (§5), monitoring metrics in the
drive record, points paused while a CRITICAL alert is active.
Engine moved to `hooks/useDriveSession.js`; speed-limit cache to `utils/speedLimit.js`; weather
helpers to `utils/driveConditions.js`.

### DriveSummary (new)
- Verdict header: "Focused drive" (confetti) or "Distracted drive" with the reason.
- Points earned (large) and streak change (+1 → N, or reset).
- Per-drive **score ring** (0–100, `utils/driveScore.js`) with the three sub-scores: Focus, Speed,
  Smoothness.
- Stats grid: duration, distance, avg speed, top speed, speeding events, hard brakes, hard
  accelerations, phone pickups; `MonitoringSummaryCard` when monitoring ran.
- **What to improve**: up to three rule-based tips computed locally (`utils/driveScore.js#getDriveTips`).
- Buttons: "Done" (→ Home) and "View history".

### Drives tab (was MyDrives + AIScreen)
- Segmented header: **History | Insights**.
- History: summary strip (drives · focused % · miles this month), list grouped by day with score chip,
  points, duration, distance, verdict icon; pull-to-refresh; pagination kept.
- DriveDetail (full screen, replaces the modal): verdict, score ring, metric groups (Focus, Speed,
  Smoothness, Monitoring, Conditions), tips.
- Insights: timeframe control, chart (phone distractions kept; eyes-off-road added when data exists),
  focus stats, driving dynamics, "Get personalized feedback" → AIFeedback (unchanged logic).
- "Clear drive history" moves to Settings › Account › Data.

### Rewards tab
- Balance card reads the profile (Firestore) — fixes the wrong AsyncStorage key.
- **Badges**: achievements computed from the drive history (`utils/achievements.js`): First drive,
  Focused ×5, Focused ×25, 100 miles, 500 miles, 7-day streak, 30-day streak, Night owl, Early bird,
  Eyes on the road (monitoring). Locked badges show progress.
- **Leaderboard preview**: top 3 with the crown assets and your rank → Leaderboard.
- **Reward catalog — coming soon**: the four categories as inline tiles with a "Soon" pill; tapping
  shows a snackbar. No dead-end screens.

### Leaderboard
Podium for the top 3 (crown assets), list, your rank pinned at the bottom, pull-to-refresh, refresh on
focus, skeleton rows while loading.

### Family (was LocationScreen)
- Not in a group: explanatory panel with two clear cards (Create / Join) and a permissions explainer.
- In a group: map (dark style in dark mode), member pins, **emergency banner** at the top when any
  member is in emergency, recenter button, "Share code" (native share sheet), bottom sheet with
  Members and Saved places, member sheet, add/edit place sheet with HERE autocomplete and "Use my
  location". Leave group in the sheet footer.
- Permissions: inline "Location sharing needs …" card with buttons instead of Alert + goBack.
- Bug fixed: group creation writes `groupName`, `createdBy`, `createdAt` to `groups/{id}`.
- Split into `components/family/*` and `utils/geo.js`.

### Settings
Grouped list: **Account** (avatar, username, email) · **Driving** (units, spoken limit, speeding
alerts, show lifetime points) · **Driver monitoring** (enable, voice / tone / haptic, sensitivity,
driver side, show camera preview) · **Safety** (trusted contacts) · **Notifications** (distraction,
drive complete, family emergency) · **Appearance** (theme, inline) · **About** (mission, replay
onboarding, version). Settings are served by `context/SettingsContext.js` (AsyncStorage-backed, same
keys as before for compatibility, plus the new monitoring keys).

### Account
Avatar, username edit, email, group, points; **Data**: clear drive history (double confirmation);
**Session**: sign out (the duplicate "Switch account" is removed).

## 4. First-run permission copy (used verbatim in Onboarding and DrivePrep)
- Location — "RoadWise uses your location to read your speed, look up speed limits and measure
  distance. Only while you drive, unless you share your location with a family group."
- Notifications — "Get a heads-up when you pick up the phone during a drive and when a family member
  signals an emergency."
- Camera — "Optional. Driver monitoring watches for eyes off the road and drowsiness using the front
  camera. Frames are processed on your phone and never uploaded."

## 5. Driver-monitoring mount-point contract

The camera-based monitoring branch supplies a real `useDriverMonitoring` hook. This branch ships a
**mock** with the same interface so every surface renders today.

### 5.1 Files
| Path | Role |
|---|---|
| `monitoring/types.js` | Enums: `ALERT_SEVERITY`, `ALERT_TYPE`, `CALIBRATION_STATE`, `MONITOR_STATUS`, `ALERT_COPY` (title, spoken phrase, icon per type) |
| `monitoring/settings.js` | Storage keys + defaults for the monitoring settings |
| `monitoring/useDriverMonitoring.js` | **Replace the body of this file.** Mock: calibrating → provisional → confirmed over ~90 s, no alerts unless `demo: true` |
| `monitoring/alertAudio.js` | `useAlertAudio(activeAlert, settings)` — the audio policy (INFO silent, WARNING once, CRITICAL repeating) using `expo-speech`, `expo-audio` (`assets/sounds/alert.mp3`) and `Vibration` |
| `monitoring/summary.js` | `emptyMonitoringSummary()`, `monitoringVerdict(metrics, settings)` — decides whether the monitoring data counts as a distracted drive |
| `components/monitoring/MonitoringStatusPill.js` | status + calibration in ≤ 3 words |
| `components/monitoring/CalibrationGate.js` | banner during CALIBRATING / PROVISIONAL / LOST with progress and "Recalibrate" |
| `components/monitoring/AlertBanner.js` | INFO / WARNING banner (also used for speeding and phone-use) |
| `components/monitoring/CriticalOverlay.js` | full-screen CRITICAL overlay |
| `components/monitoring/CameraPlacementGuide.js` | placement illustration + driver-side selector; `preview` prop slot for the live camera view |
| `components/monitoring/MonitoringSummaryCard.js` | per-drive metrics card (summary, detail, insights) |

### 5.2 Hook interface
```js
const monitoring = useDriverMonitoring({
  enabled: boolean,           // settings.monitoringEnabled && drive-level toggle
  driveActive: boolean,       // true between Start and End
  settings: {                 // from SettingsContext
    sensitivity: 'low' | 'medium' | 'high',
    driverSide: 'left' | 'right',
    showPreview: boolean,
  },
  onAlert?: (alert) => void,  // fired once per new alert
  demo?: boolean,             // mock only: emit a scripted alert sequence
});
// returns
{
  status: MONITOR_STATUS,                    // OFF | STARTING | CALIBRATING | ACTIVE | NO_FACE | CAMERA_ERROR | PERMISSION_DENIED
  calibration: { state: CALIBRATION_STATE, progress: 0..1, quality: 0..1 | null },
  activeAlert: null | { id, type: ALERT_TYPE, severity: ALERT_SEVERITY, title, message, startedAt },
  drowsiness: { level: 0 | 1 | 2 | 3, perclos: number | null },
  metrics: {                                 // cumulative for the drive
    eyesOffRoadSeconds: number,
    alertCounts: { info, warning, critical },
    alertsByType: { [ALERT_TYPE]: count },
    drowsinessPeak: 0..3,
    drowsinessHistory: [{ t: seconds-into-drive, level }],   // ≤ 120 samples
    calibrationQuality: 0..1 | null,
  },
  recalibrate: () => void,
  acknowledgeAlert: (id) => void,
  previewComponent: null | ReactElement,     // the branch may return a live preview for CameraPlacementGuide
}
```

### 5.3 Where each surface mounts (`screens/DriveScreen.js`)
Look for the `MONITORING MOUNT POINT` comments:
- `[MP-1] status pill` — top bar, centre.
- `[MP-2] alert slot` — directly under the top bar; `CalibrationGate` when
  `calibration.state ∈ {CALIBRATING, PROVISIONAL, LOST}`, else `AlertBanner` for the active INFO/WARNING
  alert (monitoring alerts take precedence over speeding and phone-use banners).
- `[MP-3] critical overlay` — last child of the screen root; renders when `activeAlert.severity ===
  CRITICAL`.
- `[MP-4] metrics into the drive record` — `finalizeDrive` in `hooks/useDriveSession.js` receives
  `monitoring.metrics` and stores them (§7).
- `[MP-5] points pause` — `useDriveSession({ pausePoints })` is `true` while a CRITICAL alert is active.
- DrivePrep: `CameraPlacementGuide preview={monitoring.previewComponent}` and the per-drive toggle.
- Settings › Driver monitoring: the toggles in §6.

### 5.4 Alert audio policy (`monitoring/alertAudio.js`)
- INFO: displayed only.
- WARNING: once on start — spoken phrase (`ALERT_COPY[type].speech`) when voice is on, else a tone when
  tone is on; one haptic pulse when haptic is on.
- CRITICAL: the same on start, then repeated every 4 s while the alert persists; haptic pattern each
  repeat. Stops as soon as `activeAlert` clears or changes.
Speed-limit speech and the speeding tone reuse the same policy through `useDriveSession`.

## 6. Settings keys (`context/SettingsContext.js`)
Existing keys keep their names so stored preferences survive:
`@speedUnit`, `@speedingWarningsEnabled`, `@showSpeedLimit`, `@displayTotalPoints`,
`@distractedNotificationsEnabled`, `@audioSpeedUpdatesEnabled`, `@appTheme` (ThemeContext).
Removed: `@showCurrentSpeed` (the speed is the screen).
New: `@monitoring.enabled` (false), `@monitoring.voiceAlerts` (true), `@monitoring.toneAlerts` (true),
`@monitoring.hapticAlerts` (true), `@monitoring.sensitivity` ('medium'), `@monitoring.driverSide`
('left'), `@monitoring.showPreview` (false), `@notify.driveComplete` (true), `@notify.familyEmergency`
(true), `@onboarded_<uid>`.

## 7. Firestore compatibility
Reads/writes keep the current layout.
- `users/{uid}`: `username`, `points`, `drivingStreak`, `photoURL`, `groupId`, `pushToken`,
  `trustedContacts`, `isDriving`. Points are now added atomically at the end of a drive
  (`addUserPoints` → `increment`).
- `users/{uid}/drivemetrics/{auto}`: existing fields unchanged (`timestamp`, `points`, `duration`,
  `distracted`, `avgSpeed`, `avgSpeedingMargin`, `suddenStops`, `suddenAccelerations`,
  `phoneUsageTime` (now actually measured), `totalDistance`, `speedingEvents`). **New optional
  fields**: `maxSpeed`, `unit`, `score`, `scoreBreakdown { focus, speed, smoothness }`,
  `wasDistracted`, `distractionReasons: string[]`, `monitoring { enabled, eyesOffRoadSeconds,
  alertCounts, alertsByType, drowsinessPeak, drowsinessHistory, calibrationQuality }`,
  `eyesOffRoadSeconds` (flat copy for queries), `weather { code, temperature, summary, roadScore }`.
- `groups/{id}`: `groupName`, `createdBy`, `createdAt` now written on creation; everything else as before.

## 8. `utils/` additions (existing functions untouched)
- `utils/firestore.js`: `addUserPoints(uid, delta)`, `getRecentDrives(uid, count)`, `getUserProfile(uid)`.
- New files: `utils/speedLimit.js`, `utils/driveConditions.js`, `utils/driveScore.js`,
  `utils/achievements.js`, `utils/geo.js`, `utils/format.js`, `utils/storageKeys.js`.

## 9. New dependency
- `expo-keep-awake` (already a transitive dependency of `expo`, now direct so it resolves from app
  code). No other dependency added.

## 10. Theme extensions (`theme/primitives.js`, additive)
`ListRow` (icon, title, subtitle, right, chevron), `Toggle` (themed Switch), `EmptyState`,
`Skeleton`, `SegmentedTabs`, `IconButton`, `ProgressBar`, `Ring` (SVG score ring), `Sheet` (modal
card), `Banner` (tone-coloured inline notice). Tokens gain `dangerFaint`, `warningFaint`,
`successFaint` for chip backgrounds.

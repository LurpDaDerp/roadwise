// One Live Activity for the drive in progress (plan §3.10). A running activity is ADOPTED, never
// replaced: at launch and at module creation one found while a drive is open
// (`drivesense.captureOpen`, written by drive-sense) is kept and any other ended; with no drive open
// every one is ended (it is stale). A push-started activity (iOS 17.2+, sent by RoadWise's server
// for a drive that started with the app in the background) arrives through `activityUpdates` and is
// adopted too. `start` updates a running activity instead of ending and requesting another.
// Updated by `update` or drive-sense's `setDriveDisplay` (the `roadwise.driveDisplay` notification),
// ended by `end` or the drive's end. The push-to-start token is persisted and announced. Each change
// of the running activity is posted as "roadwise.liveActivity", and an activity that runs takes the
// "Recording your drive" note down: the driver sees one or the other. Main thread only.
import ActivityKit
import Foundation
import UserNotifications

@available(iOS 16.2, *)
final class LiveDriveController {
  static let shared = LiveDriveController()

  /// Posted by drive-sense's `setDriveDisplay` (DriveDisplayBridge in DriveSenseModule.swift).
  static let displayNotification = Notification.Name("roadwise.driveDisplay")
  /// Posted here whenever the running activity changes: ["running": Bool] (drive-sense's DriveNotifier).
  static let stateNotification = Notification.Name("roadwise.liveActivity")
  /// drive-sense's fallback note (DriveNotifier.identifier).
  static let recordingNoteId = "roadwise.driveRecording"
  /// drive-sense's capture-open flag: a drive records.
  static let captureOpenKey = "drivesense.captureOpen"
  static let tokenKey = "livedrive.pushToStartToken"
  /// No update for this long means the app is gone: the widget then shows "-" (`context.isStale`).
  static let STALE_AFTER_S: TimeInterval = 120

  private var activity: Activity<LiveDriveAttributes>? {
    didSet {
      if activity?.id != oldValue?.id { announce() }
    }
  }
  private var observer: NSObjectProtocol?
  private var updatesTask: Task<Void, Never>?
  private var tokenTask: Task<Void, Never>?
  /// A new push-to-start token (hex), for JS (LiveDriveModule sends it as `pushToStartToken`).
  var onToken: ((String) -> Void)?

  private init() {
    observer = NotificationCenter.default.addObserver(
      forName: LiveDriveController.displayNotification, object: nil, queue: .main
    ) { [weak self] note in
      guard let self = self, let info = note.userInfo else { return }
      if info["ended"] as? Bool == true {
        self.end()
      } else {
        self.update(LiveDriveController.state(from: info))
      }
    }
    // A push-started activity (or one started while this process ran in the background).
    updatesTask = Task { @MainActor [weak self] in
      for await a in Activity<LiveDriveAttributes>.activityUpdates {
        self?.adopt(a)
      }
    }
    if #available(iOS 17.2, *) {
      tokenTask = Task { @MainActor [weak self] in
        for await data in Activity<LiveDriveAttributes>.pushToStartTokenUpdates {
          let hex = data.map { String(format: "%02x", $0) }.joined()
          UserDefaults.standard.set(hex, forKey: LiveDriveController.tokenKey)
          self?.onToken?(hex)
        }
      }
    }
  }

  static var isSupported: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

  /// The persisted push-to-start token (hex), or nil before iOS 17.2 or before one arrived.
  static var pushToStartToken: String? { UserDefaults.standard.string(forKey: tokenKey) }

  private static var driveOpen: Bool { UserDefaults.standard.bool(forKey: captureOpenKey) }

  /// A `DriveDisplayState` dictionary (keys as in drive-sense's src/types.ts) as a content state.
  static func state(from info: [AnyHashable: Any]) -> LiveDriveAttributes.ContentState {
    func number(_ key: String) -> Double? {
      guard let n = info[key] as? NSNumber else { return nil }
      let v = n.doubleValue
      return v.isFinite ? v : nil
    }
    func text(_ key: String) -> String? {
      info[key] as? String
    }
    return LiveDriveAttributes.ContentState(
      speed: number("speed"),
      limit: number("limit"),
      unit: (info["unit"] as? String) == "km/h" ? "km/h" : "mph",
      speedTint: text("speedTint"),
      speeding: info["speeding"] as? Bool ?? false,
      notDrivingAvailable: info["notDrivingAvailable"] as? Bool ?? false,
      weatherKind: text("weatherKind"),
      weatherText: text("weatherText"),
      skyTop: text("skyTop"),
      skyMid: text("skyMid"),
      skyLow: text("skyLow"),
      accent: text("accent")
    )
  }

  private static func content(_ state: LiveDriveAttributes.ContentState) -> ActivityContent<LiveDriveAttributes.ContentState> {
    ActivityContent(state: state, staleDate: Date().addingTimeInterval(STALE_AFTER_S))
  }

  private static func live(_ a: Activity<LiveDriveAttributes>) -> Bool {
    a.activityState == .active || a.activityState == .stale
  }

  /// Launch and module creation: while a drive is open the running activity is kept (any other
  /// ended); with none open every activity is stale and ends.
  func adoptRunning() {
    let all = Activity<LiveDriveAttributes>.activities
    let keep = LiveDriveController.driveOpen ? all.first(where: LiveDriveController.live) : nil
    for a in all where a.id != keep?.id {
      Task { await a.end(nil, dismissalPolicy: .immediate) }
    }
    activity = keep
    if keep != nil { removeRecordingNote() }
  }

  /// A new activity seen by `activityUpdates`: adopted when no other runs and a drive is open.
  private func adopt(_ a: Activity<LiveDriveAttributes>) {
    if a.id == activity?.id { return }
    if let current = activity, LiveDriveController.live(current) {
      Task { await a.end(nil, dismissalPolicy: .immediate) }
      return
    }
    guard LiveDriveController.driveOpen else {
      Task { await a.end(nil, dismissalPolicy: .immediate) }
      return
    }
    activity = a
    removeRecordingNote()
  }

  func isRunning() -> Bool {
    if let a = activity, LiveDriveController.live(a) { return true }
    adoptRunning()
    return activity != nil
  }

  /// Shows the drive: updates the running activity (a pushed one included), else requests one.
  /// Returns whether one is now running.
  func start(_ state: LiveDriveAttributes.ContentState) -> Bool {
    if activity == nil { adoptRunning() }
    if activity != nil {
      update(state)
      return true
    }
    guard LiveDriveController.isSupported else { return false }
    do {
      activity = try Activity.request(
        attributes: LiveDriveAttributes(startedAt: (Date().timeIntervalSince1970 * 1000).rounded()),
        content: LiveDriveController.content(state),
        pushType: nil
      )
      removeRecordingNote()
      return true
    } catch {
      activity = nil
      return false
    }
  }

  func update(_ state: LiveDriveAttributes.ContentState) {
    guard let a = activity else { return }
    let content = LiveDriveController.content(state)
    Task { await a.update(content) }
  }

  /// Ends the running activity at once.
  func end() {
    guard let a = activity else { return }
    activity = nil
    Task { await a.end(nil, dismissalPolicy: .immediate) }
  }

  private func announce() {
    NotificationCenter.default.post(name: LiveDriveController.stateNotification, object: nil, userInfo: ["running": activity != nil])
  }

  private func removeRecordingNote() {
    let center = UNUserNotificationCenter.current()
    center.removeDeliveredNotifications(withIdentifiers: [LiveDriveController.recordingNoteId])
    center.removePendingNotificationRequests(withIdentifiers: [LiveDriveController.recordingNoteId])
  }
}

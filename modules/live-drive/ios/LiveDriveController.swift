// One Live Activity for the drive in progress (plan §6). Started only by `start` (which the drive
// host calls on a drive start), updated by `update` or by drive-sense's `setDriveDisplay` through
// the `roadwise.driveDisplay` notification, ended by `end` (drive end or abort) and at module
// creation (nothing from an earlier process may linger). Main thread only.
import ActivityKit
import Foundation

@available(iOS 16.2, *)
final class LiveDriveController {
  static let shared = LiveDriveController()

  /// Posted by drive-sense's `setDriveDisplay` (DriveDisplayBridge in DriveSenseModule.swift).
  static let displayNotification = Notification.Name("roadwise.driveDisplay")

  private var activity: Activity<LiveDriveAttributes>?
  private var observer: NSObjectProtocol?

  private init() {
    observer = NotificationCenter.default.addObserver(
      forName: Self.displayNotification, object: nil, queue: .main
    ) { [weak self] note in
      guard let self = self, let info = note.userInfo else { return }
      if info["ended"] as? Bool == true {
        self.end()
      } else {
        self.update(Self.state(from: info))
      }
    }
  }

  static var isSupported: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

  /// A `DriveDisplayState` dictionary (keys as in src/types.ts) as a content state.
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
      points: number("points"),
      pointsDelta: number("pointsDelta"),
      stopped: info["stopped"] as? Bool ?? false,
      skyTop: text("skyTop"),
      skyMid: text("skyMid"),
      skyLow: text("skyLow"),
      accent: text("accent")
    )
  }

  /// No update for this long means the app is gone: the widget then shows "—" (`context.isStale`).
  static let STALE_AFTER_S: TimeInterval = 120

  private static func content(_ state: LiveDriveAttributes.ContentState) -> ActivityContent<LiveDriveAttributes.ContentState> {
    ActivityContent(state: state, staleDate: Date().addingTimeInterval(STALE_AFTER_S))
  }

  /// Starts a fresh activity (ending any still running). Returns whether one is now running.
  func start(_ state: LiveDriveAttributes.ContentState) -> Bool {
    endAll()
    guard Self.isSupported else { return false }
    do {
      activity = try Activity.request(
        attributes: LiveDriveAttributes(startedAt: Date()),
        content: Self.content(state),
        pushType: nil
      )
      return true
    } catch {
      activity = nil
      return false
    }
  }

  func update(_ state: LiveDriveAttributes.ContentState) {
    guard let a = activity else { return }
    let content = Self.content(state)
    Task { await a.update(content) }
  }

  /// Ends the running activity at once.
  func end() {
    guard let a = activity else { return }
    activity = nil
    Task { await a.end(nil, dismissalPolicy: .immediate) }
  }

  /// Ends every activity of this type, including ones an earlier process left behind.
  func endAll() {
    activity = nil
    for a in Activity<LiveDriveAttributes>.activities {
      Task { await a.end(nil, dismissalPolicy: .immediate) }
    }
  }
}

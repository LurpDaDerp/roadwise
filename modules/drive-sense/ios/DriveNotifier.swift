// The "drive started" note (Settings › Notifications › "Drive started"): posted the moment an
// automatic drive is confirmed while RoadWise isn't in front, so the driver knows RoadWise is
// recording and can say "Not driving?". Never for a Start drive (the driver started it), never for a
// drive resumed after a relaunch, and never with the switch off (`setEnabled`, kept in UserDefaults
// so a drive that starts with no JS running reads it). It shows beside the Live Activity: the
// activity carries the drive, the note says it began. Quiet: no sound, the `.active` level. A tap
// opens the driving screen (`userInfo` is the route, read by NotificationsHost). It comes down when
// RoadWise comes to the front (the driving screen shows the drive) and at every end or cancel.
// Main thread.
import Foundation
import UIKit
import UserNotifications

enum DriveNotifier {
  static let identifier = "roadwise.driveRecording"
  static let title = "Recording your drive. Stay safe."
  static let body = "Select to open your drive. Not driving? Open it to stop recording."
  /// Stored only when switched off, so a phone that never chose has it on.
  static let offKey = "drivesense.driveStartNoteOff"

  /// The "Drive started" switch (JS `DriveDetect.setStartNote`).
  static func setEnabled(_ on: Bool) {
    if on {
      UserDefaults.standard.removeObject(forKey: offKey)
    } else {
      UserDefaults.standard.set(true, forKey: offKey)
      remove()
    }
  }

  static var enabled: Bool { !UserDefaults.standard.bool(forKey: offKey) }

  /// A drive was confirmed: the note goes up at once for an automatic one, unless RoadWise is in
  /// front (the driving screen already shows it) or the switch is off.
  static func driveStarted(kind: String) {
    guard kind == "auto", enabled, UIApplication.shared.applicationState != .active else { return }
    post()
  }

  private static func post() {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.threadIdentifier = "drive-recording"
    // A local notification's `data` in JS is its whole userInfo: the route the tap opens.
    content.userInfo = ["kind": "driveRecording", "url": "/drive"]
    content.interruptionLevel = .active
    let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request) { _ in }
  }

  /// The note comes down (RoadWise in front, an end, a cancel, the switch off).
  static func remove() {
    let center = UNUserNotificationCenter.current()
    center.removeDeliveredNotifications(withIdentifiers: [identifier])
    center.removePendingNotificationRequests(withIdentifiers: [identifier])
  }
}

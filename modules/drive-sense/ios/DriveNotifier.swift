// The "Recording your drive" note (plan §3.10, A3): the fallback when no Live Activity shows a drive
// that started on its own. At every confirmation a check is scheduled 20 s out; it posts the note
// only if no Live Activity runs by then (push-to-start brings its own alert), so the driver sees one
// or the other, never both. The check is cancelled and the note removed when an activity starts or
// is adopted (modules/live-drive posts "roadwise.liveActivity"; it also removes the note itself),
// and at every end or cancel. Quiet: no sound, the `.active` level. A tap opens the driving screen.
// Main thread.
import Foundation
import UserNotifications

enum DriveNotifier {
  static let identifier = "roadwise.driveRecording"
  static let title = "Recording your drive"
  static let body = "Tap to open it. Not driving? You can stop it there."
  /// Posted by modules/live-drive whenever its activity starts, is adopted or ends: ["running": Bool].
  static let liveActivityNotification = Notification.Name("roadwise.liveActivity")

  private static var pending: DispatchWorkItem?
  private static var activityRunning = false
  private static var observer: NSObjectProtocol?

  /// Listens for the Live Activity's state (once per process).
  static func install() {
    guard observer == nil else { return }
    observer = NotificationCenter.default.addObserver(forName: liveActivityNotification, object: nil, queue: .main) { note in
      activityRunning = note.userInfo?["running"] as? Bool ?? false
      if activityRunning {
        cancel()
        remove()
      }
    }
  }

  /// A drive was confirmed: the note goes up `FALLBACK_NOTE_DELAY_MS` from now unless a Live Activity
  /// runs by then or the drive has ended (`stillRecording`).
  static func scheduleFallback(stillRecording: @escaping () -> Bool) {
    install()
    cancel()
    let work = DispatchWorkItem {
      pending = nil
      guard stillRecording(), !activityRunning else { return }
      post()
    }
    pending = work
    DispatchQueue.main.asyncAfter(wallDeadline: .now() + DetectPolicy.FALLBACK_NOTE_DELAY_MS / 1000, execute: work)
  }

  static func cancel() {
    pending?.cancel()
    pending = nil
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

  /// The note comes down (an end, a cancel, an activity running).
  static func remove() {
    let center = UNUserNotificationCenter.current()
    center.removeDeliveredNotifications(withIdentifiers: [identifier])
    center.removePendingNotificationRequests(withIdentifiers: [identifier])
  }
}

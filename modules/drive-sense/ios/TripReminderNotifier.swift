// The forgot-to-start reminder's note on iOS: "Forgot to start drive?" / "Tap here to start", one
// local notification with sound at the `.active` interruption level (a Focus holds it; it never
// breaks through), replaced rather than stacked, with no buttons and no link. It carries the note's
// one-use token; a tap reaches JS through expo-notifications and JS claims the token
// (`TripReminder.claim`) before it starts the drive. Nothing here starts or records a drive.
import Foundation
import UserNotifications

enum TripReminderNotifier {
  static let identifier = "roadwise.tripReminder"
  static let title = "Forgot to start drive?"
  static let body = "Tap here to start"

  /// Whether notifications are allowed with alerts (provisional and ephemeral are not enough). Resolves on main.
  static func authorized(_ done: @escaping (Bool) -> Void) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      let ok = settings.authorizationStatus == .authorized
      DispatchQueue.main.async { done(ok) }
    }
  }

  /// `done(true)` once the note is added; false when iOS refused it. Resolves on main.
  static func post(_ token: String, _ done: @escaping (Bool) -> Void) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    content.threadIdentifier = "trip-reminder"
    // A local notification's `data` in JS is its whole userInfo.
    content.userInfo = ["kind": "tripReminder", "reminderToken": token]
    content.interruptionLevel = .active
    let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request) { error in
      DispatchQueue.main.async { done(error == nil) }
    }
  }

  static func remove() {
    let center = UNUserNotificationCenter.current()
    center.removeDeliveredNotifications(withIdentifiers: [identifier])
    center.removePendingNotificationRequests(withIdentifiers: [identifier])
  }
}

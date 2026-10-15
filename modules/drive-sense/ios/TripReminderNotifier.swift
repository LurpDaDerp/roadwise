// The forgot-to-start reminder's notification on iOS. One local notification with sound, at the
// `.active` interruption level (a Focus holds it; it never breaks through), replaced rather than
// stacked. Tapping it opens RoadWise on Home (`url: /home`, routed by the app's one notification
// response handler); its one action, "Not driving", runs in the background and only quiets the
// reminder. Nothing here starts or records a drive.
import Foundation
import UserNotifications

enum TripReminderNotifier {
  static let identifier = "roadwise.tripReminder"
  static let category = "roadwise.tripReminder"
  static let notDrivingAction = "roadwise.tripReminder.notDriving"
  static let title = "Want to record this drive?"
  static let body =
    "Looks like you're in a car. If you're driving, tap here when you're stopped and it's safe to open RoadWise and start your drive."

  /// Adds the reminder's category to whatever categories are registered, never replacing them.
  static func registerCategory() {
    let center = UNUserNotificationCenter.current()
    let id = TripReminderNotifier.category
    let actionId = TripReminderNotifier.notDrivingAction
    center.getNotificationCategories { existing in
      let notDriving = UNNotificationAction(identifier: actionId, title: "Not driving", options: [])
      let mine = UNNotificationCategory(identifier: id, actions: [notDriving], intentIdentifiers: [], options: [])
      var all = existing.filter { $0.identifier != id }
      all.insert(mine)
      center.setNotificationCategories(all)
    }
  }

  /// Whether notifications are allowed with alerts (provisional and ephemeral are not enough). Resolves on main.
  static func authorized(_ done: @escaping (Bool) -> Void) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      let ok = settings.authorizationStatus == .authorized
      DispatchQueue.main.async { done(ok) }
    }
  }

  static func post() {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    content.categoryIdentifier = category
    content.threadIdentifier = "trip-reminder"
    // A local notification's `data` in JS is its whole userInfo.
    content.userInfo = ["url": "/home"]
    content.interruptionLevel = .active
    let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request) { _ in }
  }

  static func remove() {
    let center = UNUserNotificationCenter.current()
    center.removeDeliveredNotifications(withIdentifiers: [identifier])
    center.removePendingNotificationRequests(withIdentifiers: [identifier])
  }
}

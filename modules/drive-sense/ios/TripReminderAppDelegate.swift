// The forgot-to-start reminder's launch hooks (registered in expo-module.config.json
// `appDelegateSubscribers`). At didFinishLaunching (never willFinish) it restarts the reminder's
// wake (an app iOS relaunched for a significant-location change must ask for it again) and adds
// the "Not driving" handler to expo-notifications' delegate list. It never sets the notification
// center's delegate, and it starts nothing.
import ExpoModulesCore
import ExpoNotifications
import UIKit
import UserNotifications

public class TripReminderAppDelegate: ExpoAppDelegateSubscriber {
  private let notDriving = TripReminderNotDriving()

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NotificationCenterManager.shared.addDelegate(notDriving)
    TripReminder.shared.resumeAtLaunch()
    return true
  }
}

/// The reminder's background action. Any other response (a tap included) is left to the app's one
/// response handler, which opens Home for it.
final class TripReminderNotDriving: NotificationDelegate {
  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    guard response.actionIdentifier == TripReminderNotifier.notDrivingAction else { return false }
    TripReminder.shared.onNotDriving()
    return true
  }
}

// The forgot-to-start reminder's launch hook (registered in expo-module.config.json
// `appDelegateSubscribers`). At didFinishLaunching (never willFinish) it restarts the reminder's
// wake (an app iOS relaunched for a significant-location change must ask for it again). It adds no
// notification delegate: a tap on the reminder reaches JS through expo-notifications like any other
// response. It never sets the notification center's delegate, and it starts nothing.
import ExpoModulesCore
import UIKit

public class TripReminderAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    TripReminder.shared.resumeAtLaunch()
    return true
  }
}

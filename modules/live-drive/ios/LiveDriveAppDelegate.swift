// The Live Activity's launch hook (registered in expo-module.config.json `appDelegateSubscribers`).
// At didFinishLaunching it creates the controller, so its display observer, its `activityUpdates`
// stream (a push-started activity) and its push-to-start token stream run in every process, even a
// background relaunch before JS creates the module, and adopts a running activity while a drive is
// open (else ends it as stale). It starts nothing.
import ExpoModulesCore
import UIKit

public class LiveDriveAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    if #available(iOS 16.2, *) {
      LiveDriveController.shared.adoptRunning()
    }
    return true
  }
}
